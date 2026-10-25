// adapters/orca/main.mjs's own catalog: the worker's user-facing text
// (`notifications.show` titles/bodies, and the one thrown error a command
// caller might surface). Everything else the worker does (`orca.log`) is
// an operator diagnostic in the debug log, never shown to the user in the
// UI, and stays out of this catalog on purpose -- same line the rest of
// this codebase already draws around `orca.log`.
import type { Catalog } from "./i18n.ts";

export type AdvisorKey =
  | "title"
  | "titleDoctor"
  | "notify.noKey.body"
  | "notify.decide.body"
  | "notify.doctor.ok"
  | "notify.doctor.problem"
  | "notify.configOpenFailed"
  | "error.noApiKey"
  // adapters/orca/install-claude-integration.mjs's own failure paths (the
  // `reason`/`detail` shape it returns on save/clear key, install/revert
  // Claude integration). That script emits the `reason` code below; this
  // panel maps `reason` -> key and resolves the rest (params) from the
  // response's own fields instead of trusting its raw `detail` prose.
  | "install.missingPluginRoot"
  | "install.unknownMode"
  | "install.exception"
  | "install.symlinkFailed"
  | "install.symlinkNotOurs";

export const ADVISOR_CATALOG: Catalog<AdvisorKey> = {
  es: {
    title: "Jev Advisor",
    titleDoctor: "Jev Advisor: diagnóstico",
    "notify.noKey.body": "No hay una clave de TypeSafe configurada. Ejecuta «Advisor: Check configuration» para abrir la configuración.",
    "notify.decide.body": "{{act}} para actuar · {{blocked}} bloqueadas · {{ask}} para revisar.",
    "notify.doctor.ok": "Todo en orden. La configuración se abrió en Orca Browser.",
    "notify.doctor.problem": "Hay problemas de configuración. Se abrió la página de configuración en Orca Browser para corregirlos.",
    "notify.configOpenFailed": "No se pudo abrir la configuración local. Revisa la ruta de Orca CLI en Ajustes → General y vuelve a ejecutar «Advisor: Check configuration».",
    "error.noApiKey": "No hay TYPESAFE_API_KEY configurada en el almacén de secrets del plugin.",
    "install.missingPluginRoot": "Falta pluginRoot: uso esperado install-claude-integration.mjs <install|uninstall|status> <pluginRoot>.",
    "install.unknownMode": "Modo no reconocido: {{mode}}.",
    "install.exception": "Fallo inesperado: {{message}}",
    "install.symlinkFailed": "No se pudo enlazar el mod ({{message}}); Windows o un sistema de archivos restringido podría no permitirlo aquí.",
    "install.symlinkNotOurs": "El enlace de mod-skills no apuntaba a este plugin; se dejo sin tocar.",
  },
  en: {
    title: "Jev Advisor",
    titleDoctor: "Jev Advisor: diagnostics",
    "notify.noKey.body": "No TypeSafe key is configured. Run “Advisor: Check configuration” to open the settings page.",
    "notify.decide.body": "{{act}} to act on · {{blocked}} blocked · {{ask}} to review.",
    "notify.doctor.ok": "Everything checks out. The configuration page is open in Orca Browser.",
    "notify.doctor.problem": "Configuration problems found. The settings page opened in Orca Browser so you can fix them.",
    "notify.configOpenFailed": "Could not open the local configuration page. Check the Orca CLI path in Settings → General, then run “Advisor: Check configuration” again.",
    "error.noApiKey": "No TYPESAFE_API_KEY is configured in the plugin's secrets store.",
    "install.missingPluginRoot": "Missing pluginRoot: usage is install-claude-integration.mjs <install|uninstall|status> <pluginRoot>.",
    "install.unknownMode": "Unrecognized mode: {{mode}}.",
    "install.exception": "Unexpected failure: {{message}}",
    "install.symlinkFailed": "Couldn't symlink the mod ({{message}}); Windows or a restricted filesystem may not allow it here.",
    "install.symlinkNotOurs": "The mod-skills link didn't point at this plugin; left untouched.",
  },
};
