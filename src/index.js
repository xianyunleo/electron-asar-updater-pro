const {app} = require('electron');
const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
const {EventEmitter} = require("events");
const electronLog = require("electron-log");
const semverDiff = require("semver-diff");
const got = require("got");
const AdmZip = require("adm-zip");
const isAdmin = require("is-admin");


const Updater = class Updater extends EventEmitter {
    _options = {
        api: {
            url: null,
            body: null,
            method: 'POST',
        },
        adminRun: false,
        debug: false,
    };
    _updateFileName = 'update.asar';
    _resourcesDirName = 'resources';
    _downloadUrl = '';
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
        Finish: 100,
        Cancel: 200,
    }

    constructor(options) {
        super();
        this._isOldNode = !!this._getNodeMajorVersion() < 15;
        if (options?.test?.enable) {
            options.debug = true;
        }
        this._options = options;
        this._downloadDir = path.resolve(this.getAppDir(), this._resourcesDirName);
        if (!this._isOldNode) {
            this._dlAbortController = new AbortController();
        }
        this._log(`AppDir: ${this.getAppDir()}`);
    }

    /**
     *
     * @returns {Promise<boolean>}
     */
    async check() {
        const url = this._options?.api?.url;
        if (!url) return false;

        const appVersion = this.getAppVersion();
        this._log(`Check:appVersion:${appVersion}`);
        let respData;
        const gotOptions = {method: this._options?.api?.method ?? 'POST'};
        try {
            if (this._options?.api?.body) {
                gotOptions.json = this._options.api.body;
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
                this._changeStatus(Updater.EnumStatus.DownloadError, 'Download Error');
                throw new Error('Download Error');
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

        app.quit();
    }

    async _download() {
        let responseStream = got.stream(this._downloadUrl);
        let response = await this._getResponse(responseStream);
        let contentType = response.headers['content-type'];
        if (!fs.existsSync(this._downloadDir)) {
            fs.mkdirSync(this._downloadDir, {recursive: true});
        }
        let filePath = path.join(this._downloadDir, this._updateFileName);
        if (contentType && contentType.includes('zip')) {
            filePath = path.join(this._downloadDir, `${this._updateFileName}.zip`);
        }
        this._downloadFilePath = filePath;
        if (fs.existsSync(filePath)) {
            fs.rmSync(filePath);
        }
        let writeStream = fs.createWriteStream(filePath);

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
        const updaterPath = path.join(this.getAppDir(), 'updater.exe');
        try {
            const moduleDir = path.dirname(__dirname);
            fs.copyFileSync(path.join(moduleDir, 'updater.exe'), updaterPath);
        } catch (error) {
            throw new Error('Copy updater.exe Error');
        }
        const updateAsarPath = path.join(this._downloadDir, 'update.asar');
        const appAsarPath = path.join(this._downloadDir, 'app.asar');
        const exePath = this.getExePath();
        //是否需要以管理员身份运行updater.exe。如果程序本事就是管理员身份运行的，那么updater.exe会继承权限，不需要再提权运行。
        const needAdminRun = !(await isAdmin()) && this._options?.adminRun ? 1 : 0;

        let shell, command, args;
        if (needAdminRun) {
            shell = 'powershell';
            command = `Start-Process`;
            const updateAsarPathArg = this._getArg(updateAsarPath, true);
            const appAsarPathArg = this._getArg(appAsarPath, true);
            const exePathArg = this._getArg(exePath, true);
            args = [
                '-WindowStyle', 'hidden',
                '-FilePath', `"${updaterPath}"`,
                '-ArgumentList', `"${updateAsarPathArg} ${appAsarPathArg} ${exePathArg} ${needAdminRun} ${process.arch}"`,
                '-Verb', 'RunAs'
            ];
        } else {
            shell = true;
            command = `"${updaterPath}"`;
            const updateAsarPathArg = this._getArg(updateAsarPath);
            const appAsarPathArg = this._getArg(appAsarPath);
            const exePathArg = this._getArg(exePath);
            args = [updateAsarPathArg, appAsarPathArg, exePathArg, needAdminRun];
        }

        const options = {shell: shell, stdio: 'ignore'};

        try {
            this._log(`Update start shell process. Command:${command}, Args:${args.join(' ')}`);
            const childProcess = child_process.spawn(command, args, options);

            await new Promise((resolve, reject) => {
                if (needAdminRun) {
                    childProcess.on('exit', (code) => {
                        if (code == 1) {
                            reject('The operation has been canceled by the user');
                        } else {
                            resolve();
                        }
                    });
                } else {
                    function checkPid() {
                        if (childProcess.pid) {
                            clearInterval(intervalId);
                            resolve();
                        }
                    }
                    const intervalId = setInterval(checkPid, 100);
                    childProcess.on('error', (error) => {
                        clearInterval(intervalId);
                        reject(error);
                    });
                }
            });
        } catch (error) {
            throw new Error('Start shell process Error: ' + error);
        }
    }

    async _getResponse(stream) {
        return new Promise((resolve) => {
            stream.on('response', async response => {
                resolve(response);
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
        if (this._options?.debug) {
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
        if(this.isDev()){
            return app.getAppPath();
        }else {
            return path.dirname(this.getExePath());
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
}

module.exports = Updater;