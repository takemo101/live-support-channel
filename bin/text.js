// What the live-support CLI prints. Pure functions of their inputs, so the layout can be tested and nothing else in bin/ has to know about it.
import { join } from "node:path";

// Colour only on a terminal, and never when NO_COLOR is set; pipes and tests get plain text.
export function styler({ tty = false, noColor = false } = {}) {
  const on = tty && !noColor;
  const wrap = (open, close) => text => on ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return { bold: wrap(1, 22), dim: wrap(2, 22), cyan: wrap(36, 39), green: wrap(32, 39), yellow: wrap(33, 39) };
}

// Terminal columns, counting wide (CJK) characters as two, so Japanese labels line up with ASCII ones.
const columns = text => [...text].reduce((total, c) => total + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (text, width) => text + " ".repeat(Math.max(1, width - columns(text)));

export const AGENT_NAMES = ["claude", "omp", "pi", "agy"];

export function help(s = styler()) {
  const row = (command, text) => `  ${s.cyan(command.padEnd(28))}${text}`;
  return [
    `${s.bold("Live Support")} — 会議の字幕（Meet / Teams / Zoom）を、コーディングエージェントの1セッションへ渡します`,
    "",
    s.bold("コマンド"),
    row("live-support setup", "Chrome拡張を ~/.live-support/extension へ配置（最初の1回）"),
    row("live-support claude", "いまのプロジェクトで、会議サポート用の Claude Code を起動"),
    row("live-support token", "ペアリングトークンを表示（他人に見せない）"),
    row("live-support agents [name]", `claude / omp / pi / agy での使い方を表示（name: ${AGENT_NAMES.join(" ")}）`),
    row("live-support --help", "このヘルプ"),
    "",
    s.bold("はじめて使うとき"),
    "  1. live-support setup を実行し、chrome://extensions で「パッケージ化されていない拡張機能を読み込む」から、表示されたフォルダを選ぶ",
    "  2. 会議の前に、プロジェクトのフォルダで live-support claude を実行",
    "  3. 別のターミナルで live-support token を実行し、会議タブの DevTools「Live Support」パネルに貼る",
    "  4. パネルで会議を選び、同意にチェックして「転送開始」",
    "",
    s.bold("環境変数"),
    row("LIVE_SUPPORT_WEB=0", "Web検索と背景の調査員を使わない"),
    row("LIVE_SUPPORT_PORT", "受信ポート（既定 43821。パネルの接続先と合わせる）"),
    row("LIVE_SUPPORT_RUNTIME_DIR", "トークンなどの置き場所（既定 ~/.live-support）"),
    row("NO_COLOR=1", "色を付けない"),
    "",
  ].join("\n");
}

export function setupDone(extension, s = styler()) {
  return [
    `${s.green("✓")} Chrome拡張を配置しました`,
    `  ${s.cyan(extension)}`,
    "",
    s.bold("次の手順"),
    "  1. chrome://extensions を開き、右上の「デベロッパー モード」をON",
    "  2. 「パッケージ化されていない拡張機能を読み込む」で、上のフォルダを選ぶ（最初の1回。更新時は「再読み込み」）",
    "  3. プロジェクトのフォルダで live-support claude を実行し、別のターミナルで live-support token を実行してパネルに貼る",
    "",
  ].join("\n");
}

export function launchBanner({ project, web }, s = styler()) {
  const row = (label, text) => `  ${s.dim(pad(label, 14))}${text}`;
  return [
    `${s.bold("Live Support")} — 会議サポートを起動します`,
    row("プロジェクト", `${project}（読み取り専用）`),
    row("Web検索", web ? `ON（背景の調査員。止めるには LIVE_SUPPORT_WEB=0）` : "OFF"),
    row("次の手順", `別のターミナルで ${s.cyan("live-support token")} を実行し、DevTools「Live Support」パネルに貼る`),
    row("画面撮影", "使うなら、会議タブで拡張アイコンを1回クリック"),
    "",
  ].join("\n");
}

const pointers = root => ({
  extension: join(root, "integrations/pi/live-support.js"),
  skill: join(root, "skills/meeting/SKILL.md"),
  server: join(root, "server/main.js"),
});

// One agent's instructions. Commands only: nothing is written to the other agents' configuration.
function section(name, root, s) {
  const { extension, skill, server } = pointers(root);
  const code = text => `    ${s.cyan(text)}`;
  const next = "次に、別のターミナルで live-support token を実行し、Chromeのパネルに貼ります（トークンはエージェントを起動するたびに更新されます）。";
  switch (name) {
    case "claude": return [
      `${s.bold("claude")}  ${s.dim("push（字幕が自動で届き、返答のターンが始まる）")}`,
      "  プロジェクトのフォルダで:",
      code("live-support claude"),
      `  ${s.dim("確認状況: 実際の Claude Code で確認済み（実会議は未確認）")}`,
    ];
    case "omp": return [
      `${s.bold("omp")}  ${s.dim("push（字幕が追送メッセージとして届き、ターンが始まる）")}`,
      "  プロジェクトのフォルダで:",
      code(`omp -e ${extension} --append-system-prompt ${skill}`),
      `  ${next}`,
      `  ${s.dim("確認状況: rpc の試験で確認済み（実会議は未確認）")}`,
    ];
    case "pi": return [
      `${s.bold("pi")}  ${s.dim("push（omp と同じ拡張API）")}`,
      "  プロジェクトのフォルダで:",
      code(`pi -e ${extension} --append-system-prompt ${skill}`),
      `  ${next}`,
      `  ${s.dim("確認状況: rpc の試験で確認済み（実会議は未確認）")}`,
    ];
    case "agy": return [
      `${s.bold("agy")}  ${s.dim("pull（agy が get_captions ツールで字幕を取りに行く。agy のセッションへ押し込む方法はない）")}`,
      "  1. プロジェクトの .agents/mcp_config.json に追加:",
      ...JSON.stringify({ mcpServers: { "live-support": { command: "node", args: [server], env: { LIVE_SUPPORT_TOOLS: "1" } } } }, null, 2).split("\n").map(line => "    " + s.cyan(line)),
      "  2. ~/.gemini/antigravity-cli/settings.json で、ツールを許可:",
      code('{ "permissions": { "allow": ["mcp(live-support/get_captions)"] } }'),
      "  3. agy に、get_captions を定期的に呼ぶよう頼む（返ってきた cursor を `after` に渡す）。",
      `  ${next}`,
      `  ${s.dim("確認状況: agy では実際の取得まで確認できていません")}`,
    ];
    default: return [];
  }
}

export function agents(root, name = null, s = styler()) {
  if (name !== null) {
    if (!AGENT_NAMES.includes(name)) throw new Error(`不明なエージェント "${name}" です。${AGENT_NAMES.join(" / ")} のどれかを指定してください。`);
    return section(name, root, s).join("\n") + "\n";
  }
  const row = (agent, mode, text) => `  ${s.cyan(agent.padEnd(8))}${mode.padEnd(8)}${text}`;
  return [
    s.bold("エージェント別の使い方"),
    "",
    s.dim("  名前    方式    概要"),
    row("claude", "push", "live-support claude で起動（標準。字幕が自動で届く）"),
    row("omp", "push", "拡張を読み込んで起動（字幕が自動で届く）"),
    row("pi", "push", "omp と同じ拡張で起動"),
    row("agy", "pull", "agy が get_captions を呼んで取りに行く（設定ファイルの編集が要る）"),
    "",
    `  手順とコマンドは ${s.cyan("live-support agents <name>")} で表示します（例: live-support agents omp）。`,
    "",
  ].join("\n");
}
