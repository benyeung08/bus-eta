# 部署到 GitHub + GitHub Pages

本專案為**純靜態單文件**（`index.html`），非常適合 GitHub Pages 免費託管。
沙盒環境無法直接 `git push` 到你私人帳號，因此請**在你本機**執行以下步驟（約 2 分鐘）。

> 🔑 GPS 定位功能**必須在 https 下才會生效**，GitHub Pages 正好提供免費 HTTPS，這也是推薦部署的最大理由。

---

## 方法 A：一鍵腳本（推薦）

1. 把整個專案目錄 clone / 下載到你本機，進入目錄：

   ```bash
   cd hk-transit-eta
   ```

2. 安裝 GitHub CLI 並登入（只需做一次）：

   ```bash
   # macOS
   brew install gh
   # Windows (winget)
   winget install --id GitHub.cli
   # Linux
   sudo apt install gh

   gh auth login          # 跟指示選 GitHub.com → HTTPS → 貼上 token
   ```

3. 執行部署腳本（預設 repo 名 `hk-transit-eta`，可自訂）：

   ```bash
   bash deploy-to-github.sh              # 使用預設名稱
   bash deploy-to-github.sh my-hk-eta    # 自訂名稱
   ```

   腳本會自動：
   - ✅ 建立公開 repo
   - ✅ 用乾淨的 `gh-pages-deploy` 分支推送 `index.html` + `README.md`
   - ✅ 啟用 GitHub Pages
   - ✅ 輸出線上網址

4. 幾分鐘後開啟：

   ```
   https://<你的帳號>.github.io/<repo>/
   ```

---

## 方法 B：手動操作（不用 CLI）

1. 到 https://github.com/new 建立公開 repo（例如 `hk-transit-eta`），**不要**勾選 Initialize。

2. 把 `hk-transit-eta.html` 改名為 `index.html`，與 `README.md` 一起放進資料夾，然後：

   ```bash
   git init
   git branch -M main
   git add index.html README.md
   git commit -m "feat: 初始化香港公共交通即時 ETA 系統"
   git remote add origin https://github.com/<你的帳號>/<repo>.git
   git push -u origin main
   ```

3. 到 **Repository Settings → Pages**：
   - Source 選 `main` 分支（或 `gh-pages-deploy`）
   - 按 Save

4. 等待 1–2 分鐘，Pages 網址即生效。

---

## 目錄結構（部署後）

```
hk-transit-eta/
├── index.html              # ← 整個 App（HTML+CSS+JS），Pages 入口
├── README.md               # ← 專案說明（已附在 deploy 腳本）
├── GITHUB-DEPLOY.md        # ← 本檔
└── deploy-to-github.sh     # ← 一鍵部署腳本（可刪除）
```

---

## 注意事項

| 項目 | 說明 |
|------|------|
| **GPS 定位** | `file://` 直接開啟會被瀏覽器拒絕；部署到 Pages (https) 後正常 |
| **CORS / API** | KMB 與 Citybus 官方 API 允許瀏覽器直接呼叫；若遇 CORS 可加 GitHub Pages 的簡單 proxy |
| **自訂網域** | Settings → Pages → Custom domain 填入即可 |
| **更新程式** | 修改 `index.html` 後重新執行 `bash deploy-to-github.sh` 即可（會 force-push 到部署分支） |
| **私有 repo** | GitHub Pages 需付費方案；若要用私有，請改用 Vercel / Netlify（拖入資料夾即部署） |

---

## 備選：Vercel / Netlify（更簡單）

若不想要 GitHub Pages，可用拖放式部署：

- **Vercel**：https://vercel.com/new → 匯入 repo → Framework Preset 選 `Other` → Deploy
- **Netlify**：https://app.netlify.com/drop → 把含 `index.html` 的資料夾拖入即可

兩者都自動提供 HTTPS + 全球 CDN，GPS 定位同樣可用。
