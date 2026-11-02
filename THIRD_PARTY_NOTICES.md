# Third-party notices

The application's original source is licensed under [MIT](LICENSE). This grant does not replace the licenses of dependencies, bundled runtime components, example vendors, downloaded books, audio or separately installed models. Dependency license files are retained in the production tree; Electron's distribution includes its own license and Chromium notices. This document highlights runtime and vendored components and is not a complete transitive license inventory.

## Other direct runtime dependencies

| Component           | License                                                     | Upstream                                                            |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Electron            | MIT, with separately licensed Chromium and other components | [electron/electron](https://github.com/electron/electron)           |
| React and React DOM | MIT                                                         | [facebook/react](https://github.com/facebook/react)                 |
| @xmldom/xmldom      | MIT                                                         | [xmldom/xmldom](https://github.com/xmldom/xmldom)                   |
| unzipper            | MIT                                                         | [ZJONSSON/node-unzipper](https://github.com/ZJONSSON/node-unzipper) |

Exact versions and integrity values are recorded in `package-lock.json`. Offline ASR components and model weights are not included in the repository or the main application package; review their individual licenses before obtaining or redistributing them.

## opencc-js 1.4.2

The application uses the `opencc-js/t2cn` entry for Traditional-to-Simplified Chinese retrieval normalization. Original documents and saved ASR text are not rewritten. The package and version are pinned in `package-lock.json`.

Project: [nk2028/opencc-js](https://github.com/nk2028/opencc-js).

The package declares `MIT AND Apache-2.0`: implementation copyright (c) 2020–2021 The nk2028 Project; bundled dictionary data is generated from `opencc-data` under Apache License 2.0. Retain the package's `LICENSE`, `THIRD_PARTY_LICENSES.md` and `LICENSES/Apache-2.0.txt` when distributing it. No dictionary files are fetched at application runtime.

The implementation and dictionary-data licenses continue to apply independently of the application's MIT license.

## quickjs-emscripten 0.32.0 and bundled QuickJS WebAssembly variants

Source plugins execute in an isolated QuickJS WebAssembly instance with host-controlled network access and resource limits. Project: [justjake/quickjs-emscripten](https://github.com/justjake/quickjs-emscripten). The wrapper packages declare MIT; bundled QuickJS is also MIT licensed. Production packages, including their license files and the prebuilt asyncify WASM variant, are retained in the distribution. Third-party source scripts do not inherit the application’s Node.js or Electron APIs.

## cheerio 1.2.0

The source-plugin host uses Cheerio to parse HTML and select text/attributes without executing webpage scripts. Project: [cheeriojs/cheerio](https://github.com/cheeriojs/cheerio). Cheerio declares MIT; its package license and transitive dependency notices remain in the production dependency tree. It is a parser, not an embedded browser.

## CryptoJS 4.2.0 (bqg631 example plugin only)

The optional `examples/source-plugins/bqg631/` package vendors the official CryptoJS 4.2.0 browser bundle, with formatting and source/lint comments only. Project: [brix/crypto-js](https://github.com/brix/crypto-js). The MIT license is retained as `LICENSE.txt` inside that example and its generated ZIP; original npm archive integrity and file hash are recorded in the example README.

This library is not a host application dependency. It runs within the existing restricted plugin environment solely to reproduce the website's public client request encoding. It does not handle user credentials or grant account access, and the website's legacy protocol is not a design recommendation for new cryptographic systems. CryptoJS is no longer maintained.
