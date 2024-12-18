const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generator = require('@babel/generator').default;
const prettier = require('prettier');
const t = require('@babel/types');

// 生成短随机字符串，取 UUID 的前 8 位
function generateShortKey(prefix = 'prefix') {
  return `${prefix}.${uuidv4().replace(/-/g, '').slice(0, 8)}`;
}

async function readFile(file) {
  return fs.readFile(file, 'utf8');
}

async function writeFile(file, content) {
  return fs.writeFile(file, content, 'utf8');
}

// 添加注释并返回字符串字面量
function createStringLiteralWithComment(key, value) {
  const stringLiteral = t.stringLiteral(key);
  t.addComment(stringLiteral, 'trailing', ` ${value} `, false);
  return stringLiteral;
}

const LOCAL_REGEX_MAP = {
  zh: /[\u4e00-\u9fa5]/,
  en: /[A-Za-z]/,
  fr: /[A-Za-zÀ-ÖØ-öø-ÿœç]/i,
  es: /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/i
}

function shouldTranslate(value, locales) {
  const regex = LOCAL_REGEX_MAP[locales];
  if (regex) {
    return regex.test(value);
  }
  return false;
}

async function processFile(file, translations, config) {
  const { i18nConfigFilePath, exclude = [], prettierrc, ignoreFunctions = [], locales = 'zh' } = config
  const ext = path.extname(file);
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return;
  if (exclude.some(dir => file.includes(dir))) return;
  const content = await readFile(file);
  const ast = parser.parse(content, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  const hasI18nImport = ast.program.body.some(node =>
    t.isImportDeclaration(node) && node.source.value === i18nConfigFilePath
  );

  if (!hasI18nImport) {
    const importStatement = t.importDeclaration(
      [t.importDefaultSpecifier(t.identifier('i18next'))],
      t.stringLiteral(i18nConfigFilePath)
    );
    ast.program.body.unshift(importStatement);
  }

  traverse(ast, {
    ImportDeclaration: (path) => {
      path.skip();
    },
    CallExpression: (path) => {
      const calleeName = path.get('callee').toString();
      if (ignoreFunctions.includes(calleeName) || ['i18next.t', 't', 'console.log'].includes(calleeName)) {
        path.skip();
      }
    },
    StringLiteral: path => replaceStringLiteral(path, translations, locales),
    TemplateLiteral: path => replaceTemplateLiteral(path, translations, locales),
    JSXText: path => replaceJSXText(path, translations, locales),
  });

  const { code } = generator(ast, {
    retainLines: true,
    comments: true,
  });

  const formattedCode = await prettier.format(code, {
    parser: 'typescript',
    ...prettierrc
  });

  await writeFile(file, formattedCode);
}


function replaceStringLiteral(path, translations, locales) {
  const value = path.node.value;
  const parent = path.parent;
  if (!shouldTranslate(value, locales)) return
  const randomKey = generateShortKey();
  const stringLiteral = createStringLiteralWithComment(randomKey, value);
  let newExpression = t.callExpression(t.memberExpression(t.identifier('i18next'), t.identifier('t')), [
    stringLiteral,
  ])
  if (t.isJSXAttribute(parent)) {
    newExpression = t.jsxExpressionContainer(newExpression)
  }
  path.replaceWith(newExpression)
  translations[randomKey] = value;
}

function replaceTemplateLiteral(path, translations, locales) {
  const quasis = path.get('quasis');
  const expressions = path.get('expressions');
  const rawValueParts = quasis.map(quasi => quasi.node.value.raw);
  const expressionNames = expressions.map(expr => expr.node.name);
  const regex = LOCAL_REGEX_MAP[locales];

  if (rawValueParts.every(v => regex.test(v))) {
    const randomKey = generateShortKey();
    const translatedString = rawValueParts.map((part, index) => {
      const exprName = expressionNames[index];
      return exprName ? `${part}{{${exprName}}}` : part;
    }).join('');

    const objectExpression = t.objectExpression(
      expressions.map(expr => t.objectProperty(t.identifier(expr.node.name), t.identifier(expr.node.name), false, true))
    );
    const stringLiteral = createStringLiteralWithComment(randomKey, translatedString);
    const arr = [stringLiteral]
    if (expressionNames.length > 0) {
      arr.push(objectExpression)
    }
    path.replaceWith(t.callExpression(t.memberExpression(t.identifier('i18next'), t.identifier('t')), arr));
    translations[randomKey] = translatedString;
  }
}

function replaceJSXText(path, translations, locales) {
  const value = path.node.value.trim();
  if (!shouldTranslate(value, locales)) return
  const randomKey = generateShortKey();
  const stringLiteral = createStringLiteralWithComment(randomKey, value);
  path.replaceWith(t.jsxExpressionContainer(t.callExpression(t.memberExpression(t.identifier('i18next'), t.identifier('t')), [stringLiteral])));
  translations[randomKey] = value;
}

async function traverseDirectory(dir, translations, config) {
  const files = await fs.readdir(dir);
  await Promise.all(files.map(async (file) => {
    const filePath = path.join(dir, file);
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      await traverseDirectory(filePath, translations, config);
    } else {
      await processFile(filePath, translations, config);
    }
  }));
}

async function generateOutputFile(translations, outputDir, locales) {
  const outputFilePath = path.join(process.cwd(), outputDir, `${locales}.js`);
  const outputContent = `module.exports = ${JSON.stringify(translations, null, 2)};`;
  await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
  await writeFile(outputFilePath, outputContent);
}

module.exports = async function () {
  const configFilePath = path.resolve(process.cwd(), 'i18n-ast.config.js');
  const config = require(configFilePath);
  const { entry, output, locales } = config;
  const translations = {};

  await Promise.all(entry.map(async (entryItem) => {
    const entryPath = path.resolve(process.cwd(), entryItem);
    const stats = await fs.stat(entryPath);
    if (stats.isDirectory()) {
      await traverseDirectory(entryPath, translations, config);
    } else {
      await processFile(entryPath, translations, config);
    }
  }));

  await generateOutputFile(translations, output, locales);
};
