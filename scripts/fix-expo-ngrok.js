const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const cliRoot = path.join(rootDir, 'node_modules', 'expo', 'node_modules', '@expo', 'cli', 'build');

const targets = [
  {
    file: path.join(cliRoot, 'src', 'start', 'server', 'AsyncNgrok.js'),
    replacements: [
      [
        "                if ((0, _NgrokResolver.isNgrokClientError)(error)) {\n                    var _error_body_details;\n                    throw new _errors.CommandError('NGROK_CONNECT', [\n                        error.body.msg,\n                        (_error_body_details = error.body.details) == null ? void 0 : _error_body_details.err,\n                        _chalk().default.gray('Check the Ngrok status page for outages: https://status.ngrok.com/')\n                    ].filter(Boolean).join('\\n\\n'));\n                }",
        "                const body = error == null ? void 0 : error.body;\n                if ((0, _NgrokResolver.isNgrokClientError)(error) && body) {\n                    var _error_body_details;\n                    throw new _errors.CommandError('NGROK_CONNECT', [\n                        body.msg,\n                        (_error_body_details = body.details) == null ? void 0 : _error_body_details.err,\n                        _chalk().default.gray('Check the Ngrok status page for outages: https://status.ngrok.com/')\n                    ].filter(Boolean).join('\\n\\n'));\n                }"
      ],
      [
        "            if ((0, _NgrokResolver.isNgrokClientError)(error) && error.body.error_code === 103) {",
        "            const body = error == null ? void 0 : error.body;\n            if ((0, _NgrokResolver.isNgrokClientError)(error) && (body == null ? void 0 : body.error_code) === 103) {"
      ]
    ]
  },
  {
    file: path.join(cliRoot, 'src', 'start', 'doctor', 'ngrok', 'NgrokResolver.js'),
    replacements: [
      [
        "function isNgrokClientError(error) {\n    var _error_body;\n    return error == null ? void 0 : (_error_body = error.body) == null ? void 0 : _error_body.msg;\n}",
        "function isNgrokClientError(error) {\n    var _error_body;\n    return Boolean(error == null ? void 0 : (_error_body = error.body) == null ? void 0 : _error_body.msg);\n}"
      ]
    ]
  }
];

let changedCount = 0;

for (const target of targets) {
  if (!fs.existsSync(target.file)) {
    continue;
  }

  let content = fs.readFileSync(target.file, 'utf8');
  let updated = content;

  for (const [oldStr, newStr] of target.replacements) {
    if (updated.includes(oldStr)) {
      updated = updated.replace(oldStr, newStr);
    }
  }

  if (updated !== content) {
    fs.writeFileSync(target.file, updated);
    changedCount += 1;
  }
}

if (changedCount > 0) {
  console.log(`Applied Expo ngrok guard patch to ${changedCount} file(s).`);
}
