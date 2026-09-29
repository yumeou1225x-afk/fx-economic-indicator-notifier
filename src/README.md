# FX経済指標データ自動収集＆Discordリアルタイム配信システム
（FX Economic Indicator Scraper & Discord Delivery Pipeline）

![Language](https://img.shields.io/badge/Language-JavaScript%20(GAS%20V8)-F7DF1E?logo=javascript&logoColor=black)
![Platform](https://img.shields.io/badge/Platform-Google%20Apps%20Script-4285F4?logo=google)
![API](https://img.shields.io/badge/API-Discord%20Webhook-5865F2?logo=discord&logoColor=white)
![Automation](https://img.shields.io/badge/Trigger-Time--driven%20(Daily%2007:00)-brightgreen)

金融為替市場において高いボラティリティをもたらす重要経済指標の発表スケジュールを、外部Webメディアから自動巡回・収集し、Discordへ毎朝定時（07:00 JST）にプッシュ通知するサーバーレス自動化システムです。

手動での情報収集工数を削減し、プロップファーム等の取引規約（指標発表前後2分間の取引制限等）遵守を支援することを目的として自作・運用しています。
📸 配信イメージ（Discord通知）毎朝7:00にDiscordの指定チャンネルへ、以下のフォーマットでEmbed形式の通知が自動送信されます。🏗 システム構成・処理フローコード スニペットflowchart TD
    A[GAS タイマートリガー\n毎朝07:00実行] --> B[実行制御 / 二重通知ガード\nPropertiesServiceチェック]
    B -->|当日未通知| C[URL解決 & ページ取得\nUrlFetchApp]
    
    subgraph MultiLayerFetch [多層フォールバック機構]
        C --> C1{当日個別記事}
        C1 -->|404 or 未公開| C2{当月アーカイブ}
        C2 -->|未発見| C3{週次まとめ記事}
    end
    
    MultiLayerFetch --> D[HTML構文解析 & イベント抽出]
    
    subgraph ParsingEngine [3系統パーサーエンジン]
        D --> D1[必見イベント解析]
        D --> D2[カレンダーテーブル解析]
        D --> D3[週次テキスト解析]
    end
    
    ParsingEngine --> E[データクレンジング & フィルタリング\nUSD / JPY / GBP & 重要度判定]
    E --> F[時系列ソート & 重複排除]
    F --> G[Discord Embed Payload生成\n深夜時間帯の翌日表記変換]
    G --> H[Discord Webhook送信\nREST API / POST]
    H --> I[実行ログ記録 & 日付プロパティ更新]
    
💡 本システムの主要機能と技術的特徴1. サイト更新遅延に耐える「多層フォールバックURL解決」スクレイピング対象サイト（羊飼いのFXブログ）の更新タイミングやURL構造の差異に対応するため、3段階のフォールバック探索ロジックを実装しています。当日個別URL（/article/fxdaysYYYYMMDD.html）を直接探索未公開の場合、月次インデックス（/YYYYMM/）から当日の該当リンクを動的抽出いずれも取得できない場合、週次まとめページ（/article/YYYYMMDDweekfx.html）へフォールバック
2. 構造変化に強い「3系統パーサーエンジン」HTMLの構造変化やイレギュラーなレイアウトに対応するため、複数の解析エンジンを順次実行する冗長構成を採用しています。必見イベントパーサー: トップの重要ハイライト行を正規表現で抽出カレンダーテーブルパーサー: c-shihyo-calendar クラス内のDOM解析を行い、国別フラグ・重要度ランク（米: SS/S/AA/A/BB、他: 丸印）を判定週次テキストパーサー: テーブルが存在しない場合、日付別のテキストブロックから時間を正規化して抽出
3. 実運用に耐えうるデータクレンジング・正規化日跨ぎ時刻の補正: 27:00 などの深夜営業表記を 翌03:00 形式に自動変換し、時系列で正確に昇順ソートHTMLエンティティ・タグの除去: 特殊文字（ , " 等）のデコードおよび不要なHTMLタグのストリップ処理重複イベントの排除: 同一時刻・同一通貨・同一指標の重複をハッシュキー判定でフィルタリング
4. 運用の安定性とセキュリティ多重実行防止（排他制御）: PropertiesService に最終実行日付（LAST_NOTIFY_DATE）を記録し、同一日の二重配信を防止トリガー自己管理: ScriptApp APIを用い、既存の重複トリガーをクリーンアップしてから新規登録する安全設計機密情報の隠蔽: Discord Webhook URL等の機密情報はコード内にハードコードせず、GASのスクリプトプロパティ（環境変数）から安全にロード🛠 技術スタック分類技術用途言語JavaScript (GAS V8 Engine)全体ロジック、正規表現による文字列解析実行環境Google Apps Script (FaaS)サーバーレス環境、定期Cron実行通信 / APIUrlFetchApp / REST APIHTML取得 (HTTP GET)、Discord Webhook (HTTP POST)データ管理PropertiesService実行履歴・環境変数のKey-Value管理通知先Discord API (Embed形式)リッチテキスト・重要度別フィールド表示

📂 ファイル構成Plaintext.
├── src/
│   └── IndicatorNotifier.js   # メイン処理・スクレイピング・通知ロジック
├── discord_preview.png.png    # 動作イメージ画像
└── README.md                  # システム仕様・設計ドキュメント
