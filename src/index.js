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
        test: {
            enable: false,
            appVersion: '',
            exePath: '',
        },
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
            fs.mkdir(this._downloadDir);
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
        const options = {
            cwd: this.getAppDir(),
            shell: this._options?.debug,   //控制窗口是否显示
            detached: true,
            stdio: 'ignore',
        };
        const updateAsarPath = path.join(this._downloadDir, 'update.asar');
        const appAsarPath = path.join(this._downloadDir, 'app.asar');
        const appIsAdmin = (await isAdmin()) ? 1 : 0;
        const adminRun = this._options?.adminRun ? 1 : 0;
        const args = [updateAsarPath, appAsarPath, this.getExePath(), appIsAdmin, adminRun];
        try {
            this._log(`Update start shell process,args:"${updaterPath};${args.join(';')}"`);
            const childProcess = child_process.spawn(updaterPath, args, options);
            await new Promise((resolve, reject) => {
                // 新增于: v15.1.0
                // childProcess.on('spawn', () => {
                //     resolve();
                // });
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
        if (this._options?.test?.enable) {
            return this._options?.test?.appVersion;
        }
        const {app} = require('electron');
        return app.getVersion();
    }

    getAppDir() {
        return path.dirname(this.getExePath());
    }

    getExePath() {
        if (this._options?.test?.enable) {
            return this._options?.test?.exePath;
        }
        const {app} = require('electron');
        //可执行文件路径，Mac返回路径为 AppName.app/Contents/MacOS/AppName
        return app.getPath('exe');
    }
}

module.exports = Updater;