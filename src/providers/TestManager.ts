import {
  CancellationToken,
  Range,
  TestController,
  TestRunProfileKind,
  tests,
  TestTag,
  Uri,
  commands,
  TestRunRequest,
  workspace,
  TestItem,
  WorkspaceFolder,
  TestRun,
  Location,
  Position,
  MarkdownString,
} from "vscode";
import {basename, join, relative} from "path";
import {DEBUG_TEST_COMMAND, RUN_TEST_COMMAND} from "../common/Constants";
import {createRangeObject, getRootPath} from "../common/Helpers";
import {ConfigurationProvider} from "./ConfigurationProvider";
import {codeParser, TestEntryPoint} from "./CodeParser";
import {getMatchingConfig, getWorkingDirectory} from "../runners/MochaRunner";
import {TestRunMode} from "../commands/RunTestCommand";

export let testController: TestController | undefined = undefined;

export const TEST = "test";
export const TEST_SUITE = "testSuite";
export const FOLDER = "folder";

export const createItemId = (fileName: string, testName?: string) => {
  return testName ? `${fileName.replace(/\\/g,'/')}-${testName}` : fileName.replace(/\\/g,'/');
};

export const getTestRoot = (
  config: ConfigurationProvider,
  rootPath: WorkspaceFolder,
  fileName: string,
  controller: TestController,
  ): TestItem => {
  const rootFilePath = rootPath.uri.fsPath;
  const matchingConfig = getMatchingConfig(config, fileName);
  const relativeFilename = relative(rootFilePath, fileName);
  const root = getWorkingDirectory(rootPath, matchingConfig, config.useTSConfig, relativeFilename);
  const relativeRoot = relative(rootFilePath, root) || '<root>';
  let rootItem = undefined;
  controller.items.forEach((item) => {
    if (item.label === relativeRoot) {
      rootItem = item;
    }
  });
  if (!rootItem) {
    const uri = Uri.file(root);
    rootItem = controller.createTestItem(relativeRoot, relativeRoot, uri);
    rootItem.tags = [new TestTag(FOLDER)];
    controller.items.add(rootItem);
  }
  return rootItem;
};

const getTestRunMode = (tag: TestTag): TestRunMode => {
  switch (tag.id) {
    case TEST_SUITE:
      return TestRunMode.file;
    case TEST:
      return TestRunMode.suite;
    default:
      return TestRunMode.folder;
  }
};

export const startTestRun = (testController: TestController, runMode: TestRunMode, item: TestItem, request: TestRunRequest) => {
    const includeItems = [item];
    switch (runMode) {
      case TestRunMode.file:
        item.children.forEach((child) => includeItems.push(child));
        break;
      case TestRunMode.suite:
        if (item.parent) {
          item.parent.children.forEach((child) => {if (child.id !== item.id) {includeItems.push(child);}});
        }
        break;
      case TestRunMode.folder:
      default:
    }
    const testRun = testController.createTestRun({...request, include: includeItems});
    includeItems.forEach((item) => item.busy = true);
    return testRun;
};

export const executeTest = async  (request: TestRunRequest, token: CancellationToken, command: string) => {
  const {include} = request;
  if (include && testController && include.length === 1) {
    const [item] = include;
    const testName = item.label;
    const [tag] = item.tags;
    const runMode = getTestRunMode(tag);
    const testRun = startTestRun(testController, runMode, item, request);

    if (item.uri) {
      const rootPath = getRootPath(item.uri);
      const fileName = item.uri.fsPath;

      return commands.executeCommand(command,
        rootPath, fileName, testName, runMode, testRun, item,
      ) as Promise<void>;
    }

    return Promise.resolve();
  }
};

export const discoverTests = async (testController: TestController) => {
  testController.items.forEach(item => testController?.items.delete(item.id));
    const loadingItem = testController?.createTestItem('mocha-mono-searching', 'Searching for tests...');
    testController.items.add(loadingItem);
    const [first] = workspace.workspaceFolders || [];
    const config = new ConfigurationProvider(first);

    await Promise.all(config.testExtensions.map(async (extension) => {
      const files = await workspace.findFiles(`**/*${extension}`, `**/node_modules/**`);
      files.map(file => {
        if (testController) {
        const fileName = file.fsPath;
        const label = basename(fileName);
        const id = createItemId(fileName);

        const item = testController.createTestItem(id, label, file);
        if (item) {
          item.tags = [new TestTag(TEST_SUITE)];
          item.canResolveChildren = true;
        }
        const rootItem = getTestRoot(config, first, fileName, testController,);
        rootItem.children.add(item);
        return item;
      }});
      testController?.items.delete(loadingItem.id);
    }));
};

export const initTestController = (): TestController => {
  testController = tests.createTestController(
		'e68621e5-0cbd-4bbd-87cc-a8cea71f0648',
		'Mocha Tests'
	);

  testController.resolveHandler = async (item: TestItem | undefined) => {
    if (item && item.uri) {
      const document = await workspace.openTextDocument(item.uri);
      codeParser(document.getText(), (entryPoint: TestEntryPoint) => {
        const {loc: {start}, testName} = entryPoint;
        const testCase = testController?.createTestItem(
          createItemId(item.uri?.fsPath || '', testName),
          testName,
          item.uri,
        );

        if (testCase) {
          const range = createRangeObject(start, document);
          testCase.tags = [new TestTag(TEST)];
          testCase.range = range;
          item.children.add(testCase);
        }
      });
    }
  };

  testController.refreshHandler = async (token: CancellationToken) => {
    if (testController) {
      await discoverTests(testController);
    }
	};

	testController.createRunProfile(
		'Run Mocha Tests',
		TestRunProfileKind.Run,
		async (request, token) => executeTest(request, token, RUN_TEST_COMMAND),
	);

  testController.createRunProfile(
		'Debug Mocha Tests',
		TestRunProfileKind.Debug,
		async (request, token) => executeTest(request, token, DEBUG_TEST_COMMAND),
	);

  return testController;
};

export const addTestFile = (
  rootPath: WorkspaceFolder,
  config: ConfigurationProvider,
  fileName: string,
  testName: string,
  uri: Uri,
  range: Range,
) => {
  if (testController) {
    const root = getTestRoot(config, rootPath , fileName, testController);
    let parent = root.children.get(createItemId(fileName));
    if (!parent) {

      parent = testController.createTestItem(createItemId(fileName), basename(fileName), uri);
      parent.tags = [new TestTag(TEST_SUITE)];
      root.children.add(parent);
    }
    const item = testController.createTestItem(
      createItemId(fileName, testName),
      testName,
      uri,
    );
    item.range = range;
    item.tags = [new TestTag(TEST)];
    parent.children.add(
      item
    );
    return item;
  }
};

export const registerTestResults = (
  fileName: string,
  testName: string,
  runMode: TestRunMode,
  results: any,
  testRun: TestRun,
  item: TestItem,
) => {
  const {
    '@_failures': failures,
    '@_errors': errors,
    testcase,
  } = results.testsuite;

  const determineLocation = (failureMessage: string, fileName: string): Location | undefined => {
    // test\common\MeasurementCalculations.test.ts:47:27
    const matches = failureMessage.match(`${basename(fileName)}:([0-9]+):([0-9]+)`);
    if (matches) {
      const [, line, character] = matches;
      return new Location(Uri.file(fileName), new Position(parseInt(line, 10)-1, parseInt(character, 10)-1));
    }
    return undefined;
  };

  const determineDiff = (failureMessage: string): {expectedOutput: string, actualOutput: string} | undefined => {
    // expected 'A1A2B2' to equal 'A1A2B2l'
    const matches = failureMessage.match(/expected (.*) to .*? (.*)/);
    if (matches) {
      return {
        expectedOutput: matches[1],
        actualOutput: matches[2],
      };
    }
    return undefined;
  };

  const findMatchingItems = (className: string, name: string, runMode: TestRunMode) => {
    const results: TestItem[] = [];
    const id = createItemId(fileName, name);

    const addRelatedItems = (child: TestItem) => {
      const testName = child.id.split(`${fileName.replace(/\\/g,'/')}-`).pop() || "???";
      if (child.id === id || className.endsWith(testName) || className.startsWith(testName)) {
        results.push(child);
      }
    };

    if (runMode === TestRunMode.suite) {
      item.parent?.children.forEach(addRelatedItems);
    }
    if (runMode === TestRunMode.file) {
      item.children.forEach(addRelatedItems);
    }
    return results;
  };

  const formatMessage = (failureMessage: string): string | MarkdownString => {
    // at function_name (file:///home/user/path/to/file.ts:740:24)
    const re = /(at [^()]+) \((file:\/\/[^:]+):([0-9]+):([0-9]+)\)/gm;
    const matches = failureMessage.match(re);
    if (matches) {
      const md = new MarkdownString();
      md.supportHtml = true;
      return md.appendMarkdown(failureMessage
        .replace(/[\u00A0-\u9999<>\&]/g, i => '&#' + i.charCodeAt(0) + ';')
        .replace(/\n/gm, '<br/>\n')
        .replace(re, (match, func, file, line, character) => {
          return `${func} ([${file}:${line}:${character}](${file}#L${line}:${character}))`;
        })
      );
    }
    return failureMessage;
  };

  if (testController) {
      const errorTotal = parseInt(errors, 10) + parseInt(failures, 10);
      let totalTime = 0;
      const failureList: string[] = [];
      const failedItems: string[] = [];

      const testCases = testcase instanceof Array ? testcase : [testcase];

      testCases.forEach((test: any) => {
        const {'@_name': name, '@_time': time, m,'@_classname': className, failure: failureMessage} = test;

        failureList.push(failureMessage);
        totalTime += parseFloat(time);

        const itemsToUpdate = findMatchingItems(className, name, runMode);

        itemsToUpdate.forEach(caseItem => {;
          if (caseItem) {
            caseItem.busy = false;
            if (failureMessage) {
              failedItems.push(caseItem.id);
              const location = determineLocation(failureMessage, fileName);
              const diff = determineDiff(failureMessage) || {};
              testRun.failed(caseItem, {message: formatMessage(failureMessage), location, ...diff}, parseFloat(time));
            } else {
              if (!failedItems.includes(caseItem.id)) {
                testRun.passed(caseItem, parseFloat(time));
              }
            }
          }
        });
      });

      if (errorTotal > 0) {
        testRun.failed(item, {message: failureList.join('\n')}, totalTime);
      } else {
        testRun.passed(item, totalTime);
      }
      item.busy = false;
      testRun.end();
  }
};
