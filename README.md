# 香港公共交通即時 ETA 系統

涵蓋 **巴士、小巴、港鐵、輕鐵** 的即時到站預測系統（純靜態單文件，可直接部署到 GitHub Pages）。

## ✨ 功能一覽

| 類別 | 內容 |
|------|------|
| 🚌 巴士 | KMB 九巴（即時 API）+ Citybus 城巴（V2 API） |
| 🚐 小巴 | 動態推算 ETA + 靜態路線 |
| 🚇 港鐵 | 官方車站表 + 即時倒數 |
| 🚊 輕鐵 | 官方車站表 + 即時倒數 |
| 📍 定位 | GPS 定位最近車站 + 附近路線（需 HTTPS） |
| ⏱ 燈號 | 起點 ≤5 分閃爍 / ≤1 分即將開出；中途 ≤1 分即將到站；終點 已抵達 |
| 🌐 語言 | 繁 / 簡 / 英 三語、明 / 暗主題 |
| 🔄 同步 | 全自動 20 秒背景同步 + 秒級倒數 |

## 🚀 快速開始

### 線上使用

部署成功後（幾分鐘生效）：

```
https://<你的帳號>.github.io/<repo>/
```

### 本機使用

直接用瀏覽器開啟 `index.html` 即可。

> ⚠️ **GPS 定位功能需在 `https://` 或 `localhost` 下才會生效**，`file://` 直接開啟會被瀏覽器拒絕定位權限。因此強烈建議部署到 GitHub Pages（免費 HTTPS）。

## 📦 部署到 GitHub + GitHub Pages

完整步驟請見 **[GITHUB-DEPLOY.md](./GITHUB-DEPLOY.md)**，摘要：

```bash
# 1. 安裝並登入 GitHub CLI（只需一次）
brew install gh          # 或其他套件管理器
gh auth login

# 2. 一鍵部署（自動建 repo + 啟用 Pages）
bash deploy-to-github.sh                 # 預設名稱 hk-transit-eta
bash deploy-to-github.sh my-custom-name  # 自訂名稱
```

或手動：把 `index.html` 推送上去 → Settings → Pages → 選分支 → Save。

## 🗂 目錄結構

```
hk-transit-eta/
├── index.html           # 整個 App（HTML + CSS + JS 全部內聯），Pages 入口
├── README.md            # 本檔
├── GITHUB-DEPLOY.md     # 部署指引
└── deploy-to-github.sh  # 一鍵部署腳本
```

## 📡 資料來源

- [data.gov.hk — 九巴 KMB 即時到站](https://data.gov.hk/)
- [data.gov.hk — 城巴 Citybus V2](https://rt.data.gov.hk/v2/transport/citybus/)
- 小巴 / 港鐵 / 輕鐵：官方靜態資料 + 動態推算（政府未公開統一即時 API）

## ⚖️ 免責聲明

本專案為**非官方第三方工具**，到站時間僅供參考，實際以營運商公告為準。
