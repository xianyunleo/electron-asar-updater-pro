# electron-asar-updater-pro

专业现代化的 electron asar文件更新。目前只支持Windows，Mac todo

优点：Windows golang写的 updater.exe，不需要安装任何的runtime，支持管理员提权和自动降权

建议：因为开发模式下，路径不准确，仅测试代码跑通。完整流程，请将项目编译打包运行测试。

安装
```
npm i electron-asar-updater-pro
```

安装要求

```
Electron >= 12
Node >= 14
```

示例

```
const { app, dialog } = require('electron');
const Updater =  require("electron-asar-updater-pro");

const options = {
    api: {url: 'http://www.test.com/api'},
    debug:true
}
const updater = new Updater(options);
let canUpdate;
try {
    canUpdate =  await updater.check();
} catch (error) {
    console.log(error);
    dialog.showErrorBox('info', '检查更新失败');
}
try {
    if(canUpdate){
        await updater.update();
    }
} catch (error) {
    console.log(error);
    dialog.showErrorBox('info', '更新失败');
}
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
```

构造方法

```
options = {
    api: {
        url: '', //
        body: {},  //服务端可根据这个参数，返回不同的response json
        method: 'POST|GET', //default POST
    },
    adminRun: false, //true：管理员身份运行updater.exe；false：自动。default false。
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

如果你使用了`vue-cli-plugin-electron-builder` 作为脚手架，那么你可能需要配置`externals`，请参考 https://nklayman.github.io/vue-cli-plugin-electron-builder/guide/guide.html#native-modules