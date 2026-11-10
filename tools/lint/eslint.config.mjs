import security from "eslint-plugin-security";
import noUnsanitized from "eslint-plugin-no-unsanitized";
import globals from "globals";

export default [
  { files: ["*.js", "tests/*.js"], languageOptions: { sourceType: "script", ecmaVersion: 2023, globals: { ...globals.browser, ...globals.serviceworker, supabase: "readonly" } } },
  security.configs.recommended,
  {
    plugins: { "no-unsanitized": noUnsanitized },
    rules: {
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      // 辞書 (obj[key]) の参照は多用するため誤検出が多い
      "security/detect-object-injection": "off",
      // 秘密値の比較はしない (サーバー側 RLS で守る) ため、誤検出になる
      "security/detect-possible-timing-attacks": "off",
    },
  },
  // テストは Service Worker の ASSETS 配列を読むために Function を使う
  { files: ["tests/*.js"], rules: { "no-new-func": "off" } },
];
