import 'dotenv/config';
import path from 'path';
import fs from 'fs-extra';
import xlsx from 'node-xlsx';
import puppeteer from 'puppeteer';
import HCCrawler from '../lib/js/crawler/index.js';
import utils from './common/util.js';
import nopt from '../lib/js/util/nopt.js';
import { createLogger, closeLoggers } from './logger.js';

function help() {
  console.log(``);
  console.log(`Usage:`);
  console.log(`  $ node autotest.js [-?] [-h] [-v] [-c path_of_case(s)]`);
  console.log(``);
  console.log(`Options:`);
  console.log(`  -?, --help           show this help`);
  console.log(`  -h, --help           show this help`);
  console.log(`  -v, --verbose        enable verbose output`);
  console.log(``);
  console.log(`a few examples:`);
  console.log(`  $ node autotest.js`);
  console.log(`  $ node autotest.js -c cases/iot`);
  console.log(`  $ node autotest.js -v -c cases/iot/gateway_management.js`);

  process.exit(1);
}

const knownOpts = {
  help: Boolean,
  verbose: Boolean,
  case: String,
};

const shortHands = {
  '?': ['--help'],
  h: ['--help'],
  v: ['--verbose'],
  c: ['--case'],
};

const options = nopt(knownOpts, shortHands, process.argv, 2, { help });
if (options.help) help();

// case is a key word, and cannot be used as variable name
const { verbose = false, case: cases = 'all' } = options;
if (verbose) process.env.NODE_ENV = 'development';

function traverseDir(dir) {
  let files = [];

  fs.readdirSync(dir).forEach((file) => {
    const fullPath = path.join(dir, file).replaceAll('\\', '/');
    if (fs.lstatSync(fullPath).isDirectory()) {
      files = files.concat(traverseDir(fullPath));
    } else if (['.js', '.cjs', '.mjs'].includes(path.extname(fullPath))) {
      files.push(fullPath);
    }
  });

  return files;
}

async function scanCases(dir) {
  dir = dir.replaceAll('\\', '/');
  const isFile = (await fs.lstat(dir)).isFile();

  if (isFile && ['.js', '.cjs', '.mjs'].includes(path.extname(dir))) {
    // remove the 'src/' or './src/' prefix which is necessary for
    // fs.lstat or fs.readdir (based on project's root dir) in IDE
    // env, but is not needed for import() (based on the current js
    // file's path)
    dir = dir.replace(/(^src\/|^\.\/src\/)/g, '');
    return [dir.startsWith('./') ? dir : `./${dir}`];
  }

  // option withFileTypes and recursive are not compatible with older
  // version of node.js
  /*
  const files = (
    await fs.readdir(dir, {
      recursive: true,
      withFileTypes: true,
    })
  )
    .filter((dirent) => dirent.isFile())
    .map((file) => {
      let fsPath = `${file.parentPath}/${file.name}`.replaceAll('\\', '/');
      // in IDE mode, fs.readDir's work dir is the root dir of the work
      // space, but import()'s work dir is the current dir of the file
      // being debugged. here is a workaround to bridge this gap.
      fsPath = fsPath.replace(/(^src\/|^\.\/src\/)/g, '');
      // add './' to the beginning to cope with the requirement of import()
      return fsPath.startsWith('./') ? fsPath : `./${fsPath}`;
    });
  */

  // remove the dependency of the readdir function on the withFileTypes
  // and recursive options to downgrade the Node.js version requirement.
  const files = traverseDir(dir).map((file) => {
    // in IDE mode, fs.readDir's work dir is the root dir of the work
    // space, but import()'s work dir is the current dir of the file
    // being debugged. here is a workaround to bridge this gap.
    const fsPath = file.replace(/(^src\/|^\.\/src\/)/g, '');
    // add './' to the beginning to cope with the requirement of import()
    return fsPath.startsWith('./') ? fsPath : `./${fsPath}`;
  });

  return files;
}

let testCases;
let crawler;
let logger;

async function consume(num) {
  while (num--) {
    if (testCases.length) {
      const casePath = testCases.shift();
      // import() only supports paths like './cases/xxx',
      // import not work for paths like 'cases/xxx'
      // eslint-disable-next-line no-await-in-loop
      const { run, config } = await import(
        // './cases/wansheng/device_type_management.js'
        /* webpackIgnore: true */ casePath
        // eslint-disable-next-line no-loop-func
      ).catch((e) => {
        // fail the case immediately if not able to import it.
        // However, in this situation, we have not yet been able to
        // load the case file, so we cannot retrieve the exact project
        // name and case name (which are contained in the config object
        // of the case file). Therefore, we can only output a rough log
        // message where the project is "undefined," and the case name
        // is the name of the case file.
        logger.error(`failed to import case: ${casePath}`);
        logger.error(`${e.message || e.stack}`);
        const caseName = path.parse(path.basename(casePath)).name;
        logger.error(
          `project: undefined, test case: ${caseName}, test status: FAIL`
        );
        return {};
      });

      if (!run || !config || !config.entries?.[0]?.url) {
        logger.error(
          `failed to import case: ${casePath}, missing run(), config object or entry url`
        );
        const caseName = path.parse(path.basename(casePath)).name;
        logger.error(
          `project: undefined, test case: ${caseName}, test status: FAIL`
        );
      } else {
        // eslint-disable-next-line no-await-in-loop
        await crawler
          .queue({
            url: config.entries[0].url,
            case: { ...config, run },
          })
          // eslint-disable-next-line no-loop-func
          .catch((e) => {
            logger.error(`failed to enqueue case: ${casePath}`);
            logger.error(`${e.message || e.stack}`);
            const caseProject = config.project || 'undefined';
            const caseName =
              config.name || path.parse(path.basename(casePath)).name;
            logger.error(
              `project: ${caseProject}, test case: ${caseName}, test status: FAIL`
            );
          });
      }
    } else num = 0;
  }
}

export async function customCrawl(page, crawl, option) {
  const result = await option.case.run.call(this, page, crawl, option);

  await consume(1);
  return result;
}

async function main() {
  if (!fs.existsSync('./log') || !fs.lstatSync('./log').isDirectory()) {
    fs.mkdirSync('./log', { recursive: true });
  }

  // 1. import() function for lazy loading,
  // 2. /* webpackIgnore: true */ bypass the webpack packing process
  // 3. relative path './settings.js' works well here in both webpack and
  // non-webpack env, as well as in both windows and non-windows env.
  const { default: settings } = await import(
    /* webpackIgnore: true */ './settings.js'
  );

  logger = createLogger({
    ...settings.logOptions,
    name: 'autotest',
    label: 'autotest',
  });

  logger.debug(`process.env.NODE_ENV: ${process.env.NODE_ENV}`);

  const casePath = cases === 'all' ? settings.autotest.casesDir : cases;
  logger.debug(`test target(s): ${casePath}`);

  testCases = await scanCases(casePath);

  crawler = await HCCrawler.launch({
    // if undefined, the internal chromium will be used by default
    executablePath:
      settings?.autotest?.browserPath || puppeteer.executablePath(),
    headless: settings?.autotest?.headless || false,
    // slowMo: 10,
    ignoreHTTPSErrors: true,
    timeout: 0,
    waitUntil: 'networkidle2',
    // waitUntil: 'domcontentloaded',
    waitFor: { selectorOrFunctionOrTimeout: 500 },
    // resolve a bug for
    //  async _setBypassCSP() {
    //    if (!this._options.jQuery) return;
    //    @ts-ignore
    //    await this._page.setBypassCSP(true);
    //  }
    // !TODO, not to support jquery at this moment to avoid webpack issues
    // ! and cross origin errors
    jQuery: false,
    maxConcurrency: settings?.autotest?.maxConcurrency
      ? settings.autotest.maxConcurrency
      : 10,
    // different test cases may share the same url
    skipDuplicates: false,
    // number of retry if failing to crawling a page
    retryCount: settings?.autotest?.retryCount || 0,
    args: [
      ...[
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // '--headless',
        '--disable-gpu',
        '--disable-web-security',
      ],
      ...(settings.autotest.startMaximized ? ['--start-maximized'] : []),
      // ...(settings.autotest.incognito ? ['--incognito'] : []),
      ...(settings.autotest.tempProfile ? ['--temp-profile'] : []),
    ],

    // Function to be evaluated in browsers
    evaluatePage: () => ({
      /*
      // eslint-disable-next-line no-undef
      title: $('title').text(),
      // eslint-disable-next-line no-undef
      links: $('a'),
      */
    }),

    customCrawl,

    // Function to be called with evaluated results from browsers
    // called when each url has been processed
    onFinish: (result) => {
      (result.case.status === 'PASS' ? logger.info : logger.error)(
        `project: ${result.case.project}, test case: ${result.case.name}, test status: ${result.case.status}`
      );
    },

    defaultViewport: settings.autotest.viewPort
      ? settings.autotest.viewPort
      : null,

    logger,

    utils: {
      xlsx,
      ...utils,
    },
  });

  /*
  crawler._browser.on('targetcreated', async () => {
    const pageList = await crawler._browser.pages();
    console.log(pageList.length);
  });
  */

  await consume(
    settings?.autotest?.maxConcurrency && settings.autotest.maxConcurrency > 1
      ? settings.autotest.maxConcurrency - 1
      : 1
  );
  await crawler.onIdle();
  await crawler.close();

  await closeLoggers();
}

main();
