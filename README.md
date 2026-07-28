# 🚌 香港巴士實時 ETA 系統

> 香港巴士實時到站時間系統 — 九巴 KMB / 城巴 CTB / 龍運 LWB  
> 含天氣影響檢測、路線變動追蹤、自動更新、班次時間表

## ✨ 功能

- **實時 ETA** — 秒級倒數到站時間
- **三大公司** — KMB 九巴 / CTB 城巴 / LWB 龍運
- **天氣影響** — 自動檢測天文台警告 + 服務恢復
- **路線變動** — 取消/新增/改道/修改 即時通知
- **班次時間表** — 官方時間表 + ETA 推算
- **自動更新** — 5 層並行計時器
- **深色模式** — 三語切換 (繁中/簡中/EN)
- **PWA 支援** — 可安裝到手機主屏幕

## 🚀 一鍵部署到 GitHub Pages

### 方法一：網頁操作（最簡單）

1. **創建 GitHub 帳號** → 前往 [github.com](https://github.com) 註冊
2. **新建 Repository** → 點右上角 `+` → `New repository`
   - Repository name 填 `bus-eta`（或任何名字）
   - 設為 **Public**
   - 勾選 `Add a README file`
   - 點 `Create repository`
3. **上傳文件** → 進入 repo 後點 `Add file` → `Upload files`
   - 拖入 `hk-bus-eta-system.html`
   - 拖入 `manifest.json`
   - 點 `Commit changes`
4. **啟用 GitHub Pages** → `Settings` → 左側 `Pages`
   - Source 選 `Deploy from a branch`
   - Branch 選 `main` → 資料夾選 `/ (root)`
   - 點 `Save`
5. **等 1-2 分鐘** → 訪問 `https://你的用戶名.github.io/bus-eta/`

### 方法二：Git 命令行

```bash
# 1. 克隆你的 repo
git clone https://github.com/你的用戶名/bus-eta.git
cd bus-eta

# 2. 複製文件進去
cp /path/to/hk-bus-eta-system.html ./index.html
cp /path/to/manifest.json ./

# 3. 提交並推送
git add .
git commit -m "Deploy bus ETA system"
git push origin main
```

然後一樣去 Settings → Pages 啟用。

### 方法三：直接把 repo 名設為用戶名.github.io

如果你把 repo 命名為 `你的用戶名.github.io`（例如 `johndoe.github.io`），
GitHub 會自動啟用 Pages，網址就是 `https://johndoe.github.io/`，
不需要額外設置。

## 🔧 為什麼要用 GitHub Pages？

| 方式 | CORS 狀態 | API 可用性 |
|---|---|---|
| 雙擊 HTML (file://) | ❌ 被拒 | KMB/CTB 返回 422 |
| 本地伺服器 (localhost) | ⚠️ 部分 | 大部分可用 |
| **GitHub Pages (https)** | ✅ 正常 | **全部可用** |

GitHub Pages 提供標準的 `https://` 來源，KMB/CDN 的 CloudFront 會正常接受請求，
不會再出現 422 錯誤。

## 📱 在手機上使用

部署到 GitHub Pages 後，在手機瀏覽器打開網址：
- **Safari (iOS)**：點分享 → `加入主屏幕`
- **Chrome (Android)**：點選單 → `安裝應用`

## 📄 文件說明

| 文件 | 用途 |
|---|---|
| `hk-bus-eta-system.html` | 主程序（也可改名為 `index.html`） |
| `manifest.json` | PWA 配置（手機安裝用） |
| `README.md` | 本文件 |

## 📜 License

MIT License — 自由使用、修改、分發
