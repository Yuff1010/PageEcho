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
