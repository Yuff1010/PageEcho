# Third-party notices

## opencc-js 1.4.2

The application uses the `opencc-js/t2cn` entry for Traditional-to-Simplified Chinese retrieval normalization. Original documents and saved ASR text are not rewritten. The package and version are pinned in `package-lock.json`.

Project: [nk2028/opencc-js](https://github.com/nk2028/opencc-js).

The package declares `MIT AND Apache-2.0`: implementation copyright (c) 2020–2021 The nk2028 Project; bundled dictionary data is generated from `opencc-data` under Apache License 2.0. Retain the package's `LICENSE`, `THIRD_PARTY_LICENSES.md` and `LICENSES/Apache-2.0.txt` when distributing it. No dictionary files are fetched at application runtime.

This notice records this added dependency; it is not a complete dependency-license inventory or a change to the application's UNLICENSED status.

## quickjs-emscripten 0.32.0 and bundled QuickJS WebAssembly variants

Source plugins execute in an isolated QuickJS WebAssembly instance with host-controlled network access and resource limits. Project: [justjake/quickjs-emscripten](https://github.com/justjake/quickjs-emscripten). The wrapper packages declare MIT; bundled QuickJS is also MIT licensed. Production packages, including their license files and the prebuilt asyncify WASM variant, are retained in the distribution. Third-party source scripts do not inherit the application’s Node.js or Electron APIs.

## cheerio 1.2.0

The source-plugin host uses Cheerio to parse HTML and select text/attributes without executing webpage scripts. Project: [cheeriojs/cheerio](https://github.com/cheeriojs/cheerio). Cheerio declares MIT; its package license and transitive dependency notices remain in the production dependency tree. It is a parser, not an embedded browser.

## CryptoJS 4.2.0 (bqg631 example plugin only)

The optional `examples/source-plugins/bqg631/` package vendors the official CryptoJS 4.2.0 browser bundle, with formatting and source/lint comments only. Project: [brix/crypto-js](https://github.com/brix/crypto-js). The MIT license is retained as `LICENSE.txt` inside that example and its generated ZIP; original npm archive integrity and file hash are recorded in the example README.

This library is not a host application dependency. It runs within the existing restricted plugin environment solely to reproduce the website's public client request encoding. It does not handle user credentials or grant account access, and the website's legacy protocol is not a design recommendation for new cryptographic systems. CryptoJS is no longer maintained.
