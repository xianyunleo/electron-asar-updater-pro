const {app} = require('electron');
const FileSystem = require("original-fs");
const fsPromises = FileSystem.promises;
const path = require("path");
const child_process = require("child_process");
const {EventEmitter} = require("events");
const electronLog = require("electron-log");
const semverDiff = require("semver-diff");
const got = require("got");
const AdmZip = require("adm-zip");

const exists = async (p) => {
    return fsPromises.access(p).then(() => true).catch(() => false)
}

const Updater = class Updater extends EventEmitter {
    _options = {
        api: {
            url: null,
            body: null,
            method: 'POST',
        },
        autoRestart: true,
        debug: false,
    };
    _updateFileName = 'update.asar';
    _downloadUrl = '';
    _sha256 = '';
    _downloadDir = '';
    _downloadFilePath = '';
    _status = 0;
    _dlAbortController;
    _isOldNode = false;
    static EnumStatus = {
        Ready: 0,
        CheckError: 101,
        Downloading: 102,
        Downloaded: 103,
        DownloadError: 104,
        Extracting: 105,
        Extracted: 106,
        ExtractError: 107,
        Moving: 108,
        MoveError: 109,
        HashNoMatch: 110,
        Finish: 100,
        Cancel: 200,
    }

    constructor(options) {
        super();
        this._isOldNode = !!this._getNodeMajorVersion() < 15;
        options.autoRestart = options.autoRestart ?? true
        this._options = options;
        this._downloadDir = app.getPath('userData');
        if (!this._isOldNode) {
            this._dlAbortController = new AbortController();
        }
    }

    /**
     *
     * @returns {Promise<boolean>}
     */
    async check() {
        const url = this._options.api?.url;
        if (!url) return false;

        this._log(`AppDir: ${this.getAppDir()}`);
        const appVersion = this.getAppVersion();
        this._log(`Check:appVersion:${appVersion}`);
        let respData;
        const gotOptions = {method: this._options.api?.method ?? 'POST'};
        try {
            if (this._options.api?.body) {
                gotOptions.json = this._options.api.body;
            }
            if (this._options.api?.headers) {
                gotOptions.headers = this._options.api.headers;
            }
            respData = await got(url, gotOptions).json();
        } catch (error) {
            this._changeStatus(Updater.EnumStatus.Cancel, `Cannot connect to api url,${error.message}`);
            throw new Error(`Cannot connect to api url,${error.message}`);
        }

        if (!respData.version || !respData.asar) {
            this._changeStatus(Updater.EnumStatus.Cancel, 'Api url response not valid');
            throw new Error('Api url response not valid');
        }

        if (!semverDiff(appVersion, respData.version)) {
            this._changeStatus(Updater.EnumStatus.Cancel, 'No updates available');
            return false;
        }
        this._downloadUrl = respData.asar;
        this._sha256 =  respData.sha256;
        return true;
    }

    async update() {
        try {
            this._changeStatus(Updater.EnumStatus.Downloading);
            await this._download();
        } catch (error) {
            if (error.name === 'AbortError') {
                this._changeStatus(Updater.EnumStatus.Cancel, 'Download cancelled');
                return;
            } else {
                this._changeStatus(Updater.EnumStatus.DownloadError, `Download Error,${error}`);
                throw new Error(`Download Error,${error}`);
            }
        }

        if (this._sha256) {
            const fileBuffer = await fsPromises.readFile(this._downloadFilePath);
            if (this.sha256(fileBuffer) !== this._sha256) {
                this._changeStatus(Updater.EnumStatus.HashNoMatch, `File hash mismatch`);
                throw new Error('File hash mismatch');
            }
        }

        if (this._downloadFilePath.endsWith('.zip')) {
            try {
                this._changeStatus(Updater.EnumStatus.Extracting, 'Extracting');
                await this._zipExtract();
                this._changeStatus(Updater.EnumStatus.Extracted);
            } catch (error) {
                this._changeStatus(Updater.EnumStatus.ExtractError, 'Extract Error');
                throw new Error('Extract Error');
            }
        }

        try {
            this._changeStatus(Updater.EnumStatus.Moving, 'Moving');
            await this._move();
        } catch (error) {
            this._changeStatus(Updater.EnumStatus.MoveError, error.message);
            throw new Error(`Move Error,${error.message}`);
        }
        this._changeStatus(Updater.EnumStatus.Finish);

        if (this._options.autoRestart) {
            app.relaunch();
            app.quit();
        }

    }

    async _download() {
        let responseStream = got.stream(this._downloadUrl);
        let response = await this._getResponse(responseStream);
        let contentType = response.headers['content-type'];
        if (!await exists(this._downloadDir)) {
            await fsPromises.mkdir(this._downloadDir, {recursive: true});
        }
        let filePath = path.join(this._downloadDir, this._updateFileName);
        if (contentType && contentType.includes('zip')) {
            filePath = path.join(this._downloadDir, `${this._updateFileName}.zip`);
        }
        this._downloadFilePath = filePath;
        if (await exists(filePath)) {
            await fsPromises.rm(filePath, {force: true, recursive: true});
        }
        let writeStream = FileSystem.createWriteStream(filePath);

        responseStream.on('downloadProgress', progress => {
            this.emit('downloadProgress', progress)
        });

        if (this._isOldNode) {
            const util = require('util');
            const stream = require('stream');
            const pipeline = util.promisify(stream.pipeline);
            await pipeline(responseStream, writeStream);
        } else {
            const {pipeline} = require('node:stream/promises');
            await pipeline(responseStream, writeStream, {signal: this._dlAbortController.signal});
        }

        this._changeStatus(Updater.EnumStatus.Downloaded);
    }

    async _zipExtract() {
        let zip = new AdmZip(this._downloadFilePath);
        zip.extractAllTo(this._downloadDir, true);
    }

    stopDownload() {
        if (this._isOldNode) {
            throw new Error('This method only supports node v15 and later');
        } else {
            this._dlAbortController.abort();
        }
    }

    async _move() {
        const resourcesDir =  this.getResourcesDir();
        const updateAsarPath = path.join(this._downloadDir,this._updateFileName);
        const appAsarPath = path.join(resourcesDir, 'app.asar');

        if (!this.isDev()) {
            try {
                const bakAsarPath = path.join(this._downloadDir, 'app.bak.asar');
                await fsPromises.rm(bakAsarPath, {force: true, recursive: true}); //如果已有bak文件是只读，那么必须要先删除才能copy overwrite
                await fsPromises.copyFile(appAsarPath, bakAsarPath);
            } catch (e) {
                this._log(`Backup app.bak.asar error.${e.message}`);
            }
        }

        const canWriteResources = await this._checkWritePermission(appAsarPath);
        this._log(`CanWriteResources ${canWriteResources}`);
        if (canWriteResources) {
            this._log(`Copy ${updateAsarPath} to ${appAsarPath}`);
            await fsPromises.chmod(appAsarPath, 0o666)
            await fsPromises.copyFile(updateAsarPath, appAsarPath);
        } else {
            if (process.platform !== 'win32') {
                throw new Error('app.asar access denied');
            }

            const shell = 'powershell';
            const options = {shell: shell, stdio: 'ignore'};
            const command = `Start-Process`;
            const updateAsarPathArg = this._getArg(updateAsarPath, true);
            const appAsarPathArg = this._getArg(appAsarPath, true);
            const args = [
                '-WindowStyle', 'hidden',
                '-FilePath', 'cmd',
                '-ArgumentList', `"/c attrib -r ${appAsarPathArg} & copy /y ${updateAsarPathArg} ${appAsarPathArg}"`,
                '-Verb', 'RunAs'
            ];

            this._log(`Update start shell process. Command:${command}, Args:${args.join(' ')}`);
            try {
                const childProcess = child_process.spawn(command, args, options);
                await new Promise((resolve, reject) => {
                    childProcess.on('exit', (code) => {
                        if (code == 1) {
                            reject(new Error('The operation has been canceled by the user'));
                        } else {
                            resolve();
                        }
                    });
                    childProcess.on('error', (error) => {
                        reject(error);
                    });
                });
            } catch (error) {
                throw new Error('Start shell process Error: ' + error);
            }
        }
    }

    async _getResponse(stream) {
        return new Promise((resolve, reject) => {
            stream.on('response', response => {
                resolve(response);
            });
            stream.on('error', error => {
                reject(error);
            });
        });
    }

    _changeStatus(status, logText = '') {
        this._status = status;
        this.emit('status', status);
        if (logText) {
            this._log(logText);
        }
    }

    _log(text) {
        if (this._options.debug) {
            console.log('Updater: ', text)
        }
        electronLog.info('[ electron-asar-updater-pro ]', text)
    }

    _getNodeMajorVersion(version) {
        return parseInt(process.versions.node.split('.')[0]);
    }

    getStatus() {
        return this._status;
    }

    getAppVersion() {
        return app.getVersion();
    }

    getAppDir() {
        if (this.isDev()) {
            return app.getAppPath();
        } else {
            return path.dirname(this.getExePath());
        }
    }

    getResourcesDir() {
        if (this.isDev()) {
            return app.getAppPath();
        } else {
            return path.dirname(app.getAppPath());
        }
    }

    getExePath() {
        //可执行文件路径，Mac返回路径为 AppName.app/Contents/MacOS/AppName。dev返回node_modules\electron\dist\updater.exe
        return app.getPath('exe');
    }

    isDev() {
        return !app.isPackaged;
    }

    _getArg(str, isPowershell = false) {
        if (isPowershell) {
            return `\`"${str}\`"`;
        }
        return `"${str}"`;
    }

    async _checkWritePermission(path) {
        try {
            if (process.platform === 'win32') {
                const fileHandle  = await fsPromises.open(path, "w");
                await fileHandle?.close();
            } else {
                await fsPromises.access(path, FileSystem.constants.W_OK);
            }
            return true;
        } catch (err) {
            return false;
        }
    }

    sha256(data) {
        const crypto = require('crypto');
        const hash = crypto.createHash('sha256');
        hash.update(data);
        return hash.digest('hex');
    }
}

module.exports = Updater;