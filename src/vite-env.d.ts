/// <reference types="vite/client" />

/** package.json の version（vite.config.ts で埋め込む） */
declare const __APP_VERSION__: string;
/** ビルドした時刻（ISO） */
declare const __BUILD_TIME__: string;
/** コミットの短い番号（手元のビルドでは空） */
declare const __COMMIT__: string;
