const electron = require('electron'); // eslint-disable-line
const jsforce = require('jsforce');

// Module to control application life.
const {
  app,
  BrowserWindow,
  ipcMain,
} = electron;

// Developer Dependencies.
if (!app.isPackaged) {
  require('electron-debug')(); // eslint-disable-line
  require('electron-reloader')(module); // eslint-disable-line
}

// Additional Tooling.
const path = require('path');
const url = require('url');

// Get rid of the deprecated default.
app.allowRendererProcessReuse = true;

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let consoleWindow;

// A global collection of the various SF Org connections currently open in the
// app.
// @TODOL: find a better way to do this that isn't a global.
const sfConnections = {};

// Create the main application window.
function createWindow() {
  const display = electron.screen.getPrimaryDisplay();
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: display.workArea.width,
    height: display.workArea.height,
    frame: true,
    webPreferences: {
      nodeIntegration: false, // Disable nodeIntegration for security.
      contextIsolation: true, // Enabling contextIsolation for security.
      preload: path.join(app.getAppPath(), 'app/preload.js'),
    },
  });

  // and load the index.html of the app.
  mainWindow.loadURL(url.format({
    pathname: path.join(app.getAppPath(), 'app/index.html'),
    protocol: 'file:',
    slashes: true,
  }));

  // Emitted when the window is closed.
  mainWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null;
  });
}

// Create the logging console window.
// @TODO: Generalize this and merge with previous function.
function createLoggingConsole() {
  const display = electron.screen.getPrimaryDisplay();
  // Create the browser window.
  consoleWindow = new BrowserWindow({
    width: Math.min(1200, display.workArea.width),
    height: display.workArea.height / 2,
    frame: true,
    webPreferences: {
      nodeIntegration: false, // Disable nodeIntegration for security.
      contextIsolation: true, // Enabling contextIsolation for security.
      preload: path.join(app.getAppPath(), 'app/consolePreload.js'),
    },
  });
  consoleWindow.loadURL(url.format({
    pathname: path.join(app.getAppPath(), 'app/console.html'),
    protocol: 'file:',
    slashes: true,
  }));

  // Emitted when the window is closed.
  consoleWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    consoleWindow = null;
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);
app.on('ready', createLoggingConsole);

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On OS X it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createWindow();
    createLoggingConsole();
  }
});

// @TODO: Break out the definition of all these into a file and just bulk load.

// Handle Salesforce Login
ipcMain.on('sf_login', (event, args) => {
  const conn = new jsforce.Connection({
    // you can change loginUrl to connect to sandbox or prerelease env.
    loginUrl: args.url,
  });

  let { password } = args;
  if (args.token !== '') {
    password = `${password}${args.token}`;
  }

  conn.login(args.username, password, (err, userInfo) => {
    if (err) {
      consoleWindow.webContents.send('log_message', {
        sender: event.sender.getTitle(),
        channel: 'Error',
        message: `Login Failed ${err}`,
      });

      mainWindow.webContents.send('sfShowOrgId', {
        status: false,
        message: 'Login Failed',
        response: err,
        limitInfo: conn.limitInfo,
      });
      return true;
    }
    // Now you can get the access token and instance URL information.
    // Save them to establish connection next time.
    consoleWindow.webContents.send('log_message', {
      sender: event.sender.getTitle(),
      channel: 'Info',
      message: `New Connection to ${conn.instanceUrl} with Access Token ${conn.accessToken}`,
    });
    consoleWindow.webContents.send('log_message', {
      sender: event.sender.getTitle(),
      channel: 'Info',
      message: `Connection Org ${userInfo.organizationId} for User ${userInfo.id}`,
    });

    // Save the next connection in the global storage.
    sfConnections[userInfo.organizationId] = conn;

    mainWindow.webContents.send('response_login', {
      status: true,
      message: 'Login Successful',
      response: userInfo,
    });
    return true;
  });
});

/**
 * Logout of a Salesforce org.
 */
ipcMain.on('sf_logout', (event, args) => {
  const conn = sfConnections[args.org];
  conn.logout((err) => {
    if (err) {
      mainWindow.webContents.send('response_logout', {
        status: false,
        message: 'Logout Failed',
        response: err,
        limitInfo: conn.limitInfo,
      });
      consoleWindow.webContents.send('log_message', {
        sender: event.sender.getTitle(),
        channel: 'Error',
        message: `Logout Failed ${err}`,
      });
      return true;
    }
    // now the session has been expired.
    mainWindow.webContents.send('response_logout', {
      status: true,
      message: 'Logout Successful',
      response: {},
      limitInfo: conn.limitInfo,
    });
    return true;
  });
});

/**
 * Query Salesforce.
 */
ipcMain.on('sf_query', (event, args) => {
  const conn = sfConnections[args.org];
  conn.query(args.rest_api_soql_text, (err, result) => {
    if (err) {
      mainWindow.webContents.send('response_generic', {
        status: false,
        message: 'Query Failed',
        response: err,
        limitInfo: conn.limitInfo,
      });
      consoleWindow.webContents.send('log_message', {
        sender: event.sender.getTitle(),
        channel: 'Error',
        message: `Query Failed ${err}`,
      });
      return true;
    }
    // Send records back to the interface.
    mainWindow.webContents.send('response_query', {
      status: true,
      message: 'Query Successful',
      response: result,
      limitInfo: conn.limitInfo,
    });
    return true;
  });
});

/**
 * Search Salesforce.
 */
ipcMain.on('sf_search', (event, args) => {
  const conn = sfConnections[args.org];
  conn.search(args.rest_api_sosl_text, (err, result) => {
    if (err) {
      mainWindow.webContents.send('response_generic', {
        status: false,
        message: 'Search Failed',
        response: err,
        limitInfo: conn.limitInfo,
      });
      consoleWindow.webContents.send('log_message', {
        sender: event.sender.getTitle(),
        channel: 'Error',
        message: `Search Failed ${err}`,
      });
      return true;
    }

    // Re-package results for easy display.
    const adjustedResult = {
      records: result.searchRecords,
      totalSize: 'n/a',
    };

    // Send records back to the interface.
    mainWindow.webContents.send('response_query', {
      status: true,
      message: 'Search Successful',
      response: adjustedResult,
      limitInfo: conn.limitInfo,
    });
    return true;
  });
});

/**
 * Describe Object Type.
 */
ipcMain.on('sf_describe', (event, args) => {
  const conn = sfConnections[args.org];
  conn.sobject(args.rest_api_describe_text).describe((err, result) => {
    if (err) {
      mainWindow.webContents.send('response_generic', {
        status: false,
        message: 'Describe Failed',
        response: err,
        limitInfo: conn.limitInfo,
      });

      consoleWindow.webContents.send('log_message', {
        sender: event.sender.getTitle(),
        channel: 'Error',
        message: `Describe Failed ${err}`,
      });
      return true;
    }

    // Send records back to the interface.
    mainWindow.webContents.send('response_describe', {
      status: true,
      message: `Describe ${args.rest_api_describe_text} Successful`,
      response: result,
      limitInfo: conn.limitInfo,
    });
    return true;
  });
});

/**
 * Get the Org Object.
 */
ipcMain.on('sf_orgExplore', (event, args) => {
  const conn = sfConnections[args.org];

  // Get the org object's list of fields.
  conn.sobject('Organization').describe((err, result) => {
    if (err) {
      mainWindow.webContents.send('response_generic', {
        status: false,
        message: 'Describe Org in fetch process failed',
        response: err,
        limitInfo: conn.limitInfo,
      });

      consoleWindow.webContents.send('log_message', {
        sender: event.sender.getTitle(),
        channel: 'Error',
        message: `Describe Org in fetch process failed ${err}`,
      });
      return true;
    }

    // Iterate over the list of fields and write a useful query.
    let fields = '';
    for (let i = 0; i < result.fields.length; i += 1){
      if (i === 0) {
        fields = result.fields[i].name;
      } else {
        fields = `${fields}, ${result.fields[i].name}`;
      }
    }

    const orgQuery = `SELECT ${fields} FROM Organization`;

    conn.query(orgQuery, (err, result) => {
      if (err) {
        mainWindow.webContents.send('response_generic', {
          status: false,
          message: 'Org Fetch Failed',
          response: err,
          limitInfo: conn.limitInfo,
        });

        consoleWindow.webContents.send('log_message', {
          sender: event.sender.getTitle(),
          channel: 'Error',
          message: `Org Fetch Failed ${err}`,
        });
        return true;
      }

      // Send records back to the interface.
      mainWindow.webContents.send('response_org_object_display', {
        status: true,
        message: 'Fetched Org Details',
        response: result.records[0],
        limitInfo: conn.limitInfo,
      });
      return true;
    });
  });
});


// Get a logging message from a renderer.
ipcMain.on('eforce_send_log', (event, args) => {
  consoleWindow.webContents.send('log_message', {
    sender: event.sender.getTitle(),
    channel: args.channel,
    message: args.message,
  });
  return true;
});
