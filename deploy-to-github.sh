#!/usr/bin/env bash
# 部署香港交通 ETA 專案到 GitHub：新建公開 repo + 啟用 GitHub Pages
# 使用方式：bash deploy-to-github.sh [repo-name] [commit-message]
set -euo pipefail

REPO="${1:-hk-transit-eta}"
COMMIT_MSG="${2:-feat: 初始化香港公共交通即時 ETA 系統（巴士/小巴/港鐵/輕鐵）}"
WORKDIR="/data/workspace"
HTML="hk-transit-eta.html"

cd "$WORKDIR"

# 基本檢查
command -v gh >/dev/null 2>&1 || { echo "❌ 需要 gh CLI（GitHub CLI）"; exit 1; }
[ -f "$HTML" ] || { echo "❌ 找不到 $HTML"; exit 1; }

# 登入狀態
gh auth status >/dev/null 2>&1 || { echo "❌ 請先執行 'gh auth login'"; exit 1; }

USERNAME="$(gh api user --jq .login)"
echo "👤 GitHub 帳號：$USERNAME"
echo "📦 倉庫名稱：$REPO"

# 初始化 git（若尚未）
if [ ! -d .git ]; then
  git init -q
  git branch -M main
fi

# 準備乾淨的部署目錄（避免把測試腳本送上去）
mkdir -p deploy
cp "$HTML" deploy/index.html

# 加入 README（GitHub Pages 首頁說明）
cat > deploy/README.md <<'EOF'
# 香港公共交通即時 ETA 系統

涵蓋 **巴士、小巴、港鐵、輕鐵** 的即時到站預測，支援：

- 🚌 巴士：KMB 九巴（即時 API）+ Citybus 城巴（V2 API）
- 🚐 小巴：動態推算 ETA
- 🚇 港鐵 / 🚊 輕鐵：官方車站表 + 即時倒數
- 📍 GPS 定位最近車站 + 附近路線
- ⏱ 起點 / 中途 / 終點「時間燈號」（≤5 分閃爍、≤1 分即將開出 / 到站 / 已抵達）
- 🌐 繁 / 簡 / 英 三語、明 / 暗主題
- 🔄 全自動 20 秒背景同步 + 秒級倒數

## 線上預覽

部署成功後，GitHub Pages 網址：

`https://<你的帳號>.github.io/<repo>/`

## 本地使用

直接用瀏覽器開啟 `index.html` 即可。GPS 定位功能需在 `https://` 或 `localhost` 下才會生效（`file://` 不支援）。

## 資料來源

- [data.gov.hk - 九巴 KMB 即時到站](https://data.gov.hk/)
- [data.gov.hk - 城巴 Citybus V2](https://rt.data.gov.hk/v2/transport/citybus/)
- 小巴 / 港鐵 / 輕鐵：官方靜態資料 + 動態推算（政府未公開統一即時 API）

## 免責聲明

本專案為非官方第三方工具，到站時間以營運商公告為準。
EOF

# 建立 GitHub repo（公開、自動 README）
if gh repo view "$USERNAME/$REPO" >/dev/null 2>&1; then
  echo "⚠️ 倉庫已存在，改為推送更新"
else
  gh repo create "$REPO" --public --add-readme --description "香港公共交通即時 ETA 系統（巴士/小巴/港鐵/輕鐵）" --homepage ""
fi

# 設定 remote
git remote remove origin >/dev/null 2>&1 || true
git remote add origin "https://github.com/$USERNAME/$REPO.git"

# 用獨立分支發布（避免把工作區雜物送上去）
git checkout --orphan gh-pages-deploy >/dev/null 2>&1 || git checkout -B gh-pages-deploy
git rm -rf --cached . >/dev/null 2>&1 || true
cp deploy/index.html index.html
cp deploy/README.md README.md
git add index.html README.md
git -c user.email="yuanbao@local" -c user.name="Yuanbao" commit -m "$COMMIT_MSG" >/dev/null 2>&1 || true

# 推送並設定 GitHub Pages（source = gh-pages 分支）
git push -u origin gh-pages-deploy --force

gh api "repos/$USERNAME/$REPO/pages" --method POST \
  --field "build_type=legacy" \
  --field "source[branch]=gh-pages-deploy" \
  --field "source[path]=/" >/dev/null 2>&1 || true

# 嘗試啟用 Pages（若已啟用會失敗，忽略）
gh api "repos/$USERNAME/$REPO" --method PATCH --field "has_pages=true" >/dev/null 2>&1 || true

echo ""
echo "✅ 部署完成！"
echo "🔗 倉庫：https://github.com/$USERNAME/$REPO"
echo "🌐 Pages（幾分鐘後生效）：https://$USERNAME.github.io/$REPO/"
echo ""
echo "💡 若 Pages 未自動啟用，請到 Repository Settings → Pages → Source → 選擇 'gh-pages-deploy' 分支"
