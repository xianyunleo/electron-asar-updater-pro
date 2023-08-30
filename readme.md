# electron-asar-updater-pro

专业现代化的 electron asar文件更新。支持Windows、Mac 、Linux

优点：Windows 无需额外的 exe，支持C盘Program Files目录下的更新。

建议：因为开发模式下，路径不准确，仅测试代码跑通。完整流程，请将项目编译打包运行测试。

安装
```
npm i electron-asar-updater-pro
```

安装要求

```
Electron >= 13
Node >= 14
```

示例

```
//Renderer Process
async function check() {
    try {
        const result = await ipcRenderer.invoke('updater-check');
        if(result){
            await update();
        }
    } catch (error) {
        console.log('检查更新失败');
        console.log(error);
    }
};

async function update() {
    try {
        ipcRenderer.on('updater-download-progress', (event, message) => {
            console.log(message)
        })
        await ipcRenderer.invoke('updater-update');
    } catch (error) {
        console.log('更新失败');
        console.log(error);
    }
};

//Main Process
const options = {
    api: {url: 'http://www.test.com/api'},
    debug: true
}
const updater = new Updater(options);

ipcMain.handle('updater-check', async (event, data) => {
    return await updater.check();
});

ipcMain.handle('updater-update', async (event, data) => {
    updater.on('downloadProgress', progress => {
        event.sender.send('updater-download-progress', progress)
    });
    await updater.update();
});
```

服务端api json 
```
{
    "version": "1.1.0",
    "asar": "http://www.test.com/update.asar"
}

如果asar是zip文件，那么结构如下
── update.zip
└── update.asar

update.asar或者update.zip 文件名随意，只要格式正确
```

构造方法

```
options = {
    api: {
        url: '', //
        body: {},  //服务端可根据这个参数，返回不同的response json
        method: 'POST|GET', //default POST
    },
    debug: false,
};
const updater = new Updater(options);
```

方法

```
async check(); //检查是否有更新，本地版本号和远程版本号比较
async update(); //更新并重启软件，必须先执行check方法
stopDownload(); //停止下载，仅限node v15及以上版本。
```

事件
```
updater.on('downloadProgress', progress => {
    //下载进度
});

updater.on('status', status => {
    //Updater.EnumStatus，更新的状态，用作参考。 
});
```
静态属性
```
Updater.EnumStatus; //更新的状态
```

其它：

如果你使用了`electron-vite` 作为脚手架，那么你可能需要配置`build.rollupOptions.external: ["original-fs"],`，请参考 https://cn.electron-vite.org/config/#%E5%86%85%E7%BD%AE%E9%85%8D%E7%BD%AE

如果你使用了`vue-cli-plugin-electron-builder` 作为脚手架，那么你可能需要配置`externals: ["electron-asar-updater-pro"],`，请参考 https://nklayman.github.io/vue-cli-plugin-electron-builder/guide/guide.html#native-modules