# Windows 版每月活動同步

此版本是在 Windows 本機開啟瀏覽器控制頁面的啟動程式；它不是單一免安裝執行檔，必須和本資料夾內的程式檔一起使用。

## 第一次設定

1. 安裝 Node.js 20 或更新版本，安裝後關閉並重新開啟 Windows 視窗。
2. 將整個壓縮檔解壓縮到電腦上。不要直接在壓縮檔中執行，也不要只複製啟動檔。
3. 複製 `.env.example` 並重新命名為 `.env`，使用記事本填入 Gemini API 金鑰及 Facebook 專頁網址。請妥善保管 `.env`，不要公開上傳。
4. 雙擊 `Windows-setup.cmd`。它會安裝程式套件與瀏覽器，並開啟 Facebook 和 Linktree 登入畫面。依視窗及命令提示完成兩個網站登入，最後按 Enter。
5. 雙擊 `Windows-start.cmd`，在開啟的頁面選擇目標年、月並按「開始整理」。核對內容後，才按「確認並更新 Linktree」。

如要產生可雙擊的 `.exe` 啟動器，可在 Windows 電腦上雙擊 `Windows-build-app.cmd`。成功後會在此資料夾產生 `MonthlySync.exe`，其功能與 `Windows-start.cmd` 相同，仍須保留完整資料夾及 Node.js。

Facebook 和 Linktree 的登入狀態儲存在這台 Windows 電腦上；若登入失效，請重新執行 `Windows-setup.cmd`。若瀏覽器找不到，請確認安裝步驟已順利完成。

請核對課表與貼文的**年份**：目前搜尋主要依月份，無法保證辨認貼文年份。選擇過去月份並發布，也會變更目前的 Linktree 內容。

發生啟動問題時，請查看 `data\dashboard-error.log`、`data\dashboard.log`，或工具頁面的執行紀錄。同步服務只在本機啟動，不提供網際網路遠端存取。

建立新計畫時，程式會查詢 Google 官方價格、退役公告及模型能力，從穩定 Gemini Flash-Lite 文字模型選擇合適的低價模型，並發送極短測試確認存取權限；此測試可能消耗少量 API 額度。需要網路與有效的 Gemini API 金鑰。模型及費率可在執行紀錄查看。
