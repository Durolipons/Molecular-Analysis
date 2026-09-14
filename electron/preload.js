const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', Object.freeze({
    isElectron: true,
    platform: process.platform
}));