// Configuracion de Karma para el dashboard.
//
// En este equipo el repo vive en WSL y NO hay Chrome nativo dentro de WSL, pero si el Chrome de
// Windows, alcanzable por interop de WSL. Karma solo lanza un proceso, asi que le vale el
// chrome.exe de Windows; el navegador puede volver al servidor de Karma porque WSL reenvia
// localhost a Windows. Los timeouts son largos a proposito: el primer arranque de un .exe
// cross-boundary tarda bastante mas que un binario nativo.
//
// Para usar otro navegador: CHROME_BIN=/ruta/a/chrome npm run test

const fs = require('node:fs');
const path = require('node:path');

// Navegadores nativos: si existe uno, se usa tal cual.
const NATIVOS = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

// Navegador de Windows visto desde WSL: hay que pasarlo por tools/chrome-wsl.sh, que traduce las
// rutas de Linux (--user-data-dir=/tmp/...) a rutas de Windows. Sin eso arranca y muere con codigo
// 21, y Karma solo dice "Cannot start ChromeHeadless".
//
// Edge esta en la lista porque es Chromium y sirve igual: en este equipo Chrome desaparecio y los
// tests tienen que seguir corriendo con lo que haya.
const WRAPPERS_WSL = [
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const existe = (ruta) => {
  try {
    return fs.existsSync(ruta);
  } catch {
    return false;
  }
};

const nativo = NATIVOS.find(existe);
const deWindows = !nativo && WRAPPERS_WSL.find(existe);
const wrapper = path.join(__dirname, 'tools', 'chrome-wsl.sh');

const encontrado = nativo || (deWindows ? wrapper : undefined);

if (encontrado === wrapper) {
  process.env.CHROME_WSL_BIN = deWindows;
  console.log(`[karma] navegador de Windows via tools/chrome-wsl.sh -> ${path.normalize(deWindows)}`);
} else if (encontrado) {
  console.log(`[karma] CHROME_BIN = ${path.normalize(encontrado)}`);
} else {
  console.error(
    '[karma] No se encontro ningun navegador. Exporta CHROME_BIN apuntando a tu chrome/chromium.',
  );
}

process.env.CHROME_BIN = encontrado || process.env.CHROME_BIN;

module.exports = function (config) {
  config.set({
    basePath: '',
    frameworks: ['jasmine'],
    plugins: [
      require('karma-jasmine'),
      require('karma-chrome-launcher'),
      require('karma-jasmine-html-reporter'),
      require('karma-coverage'),
    ],
    client: {
      jasmine: {},
      clearContext: false,
    },
    coverageReporter: {
      dir: path.join(__dirname, 'coverage'),
      subdir: '.',
      reporters: [{ type: 'html' }, { type: 'text-summary' }],
    },
    reporters: ['progress'],
    browsers: ['ChromeHeadlessNoSandbox'],
    // Un unico navegador: con el Chrome/Edge de Windows, Karma lanzaba dos instancias y la suite
    // se ejecutaba dos veces (el recuento salia duplicado).
    concurrency: 1,
    customLaunchers: {
      ChromeHeadlessNoSandbox: {
        base: 'ChromeHeadless',
        // --no-sandbox y --disable-dev-shm-usage: /dev/shm es pequeno en WSL y Chrome se cae sin esto.
        flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      },
    },
    // Sin re-ejecuciones: aqui se conectaba mas de un navegador y la suite corria dos veces, con
    // recuentos duplicados. Una pasada, un navegador, un resultado.
    autoWatch: false,
    restartOnFileChange: false,
    // El navegador de Windows tarda en cerrar y se desconecta del servidor de Karma, que ya esta
    // apagandose: sin esto, una ejecucion con TODO en verde sale con codigo 1 y no se puede usar
    // en un script.
    browserDisconnectTolerance: 5,
    singleRun: true,
    // Arrancar un .exe de Windows desde WSL tarda; de ahi los timeouts altos.
    captureTimeout: 180000,
    browserNoActivityTimeout: 120000,
    browserDisconnectTimeout: 30000,
    pingTimeout: 60000,
  });
};
