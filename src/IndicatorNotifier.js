// 1行目をこれに変更
const DISCORD_WEBHOOK_URL = getDiscordWebhookUrl_();
const TIME_ZONE = 'Asia/Tokyo';
const SOURCE_BASE_URL = 'https://kissfx.com';
const WARNING_TEXT = '※発表の前後2分間（計4分間）はプロップファームの取引禁止時間です';

const TARGET_COUNTRIES = {
  '米': { currency: 'USD', label: '米国' },
  '日': { currency: 'JPY', label: '日本' },
  '英': { currency: 'GBP', label: '英国' },
};

function notifyTodayFxIndicators() {
  runNotifier_(false);
}

function testNotifyTodayFxIndicators() {
  runNotifier_(true);
}

function createDailyTrigger() {
  deleteDailyTrigger_();
  ScriptApp.newTrigger('notifyTodayFxIndicators')
    .timeBased()
    .atHour(7)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(TIME_ZONE)
    .create();
}

function deleteDailyTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'notifyTodayFxIndicators')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function runNotifier_(force) {
  const todayKey = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();

  if (!force && props.getProperty('LAST_NOTIFY_DATE') === todayKey) {
    Logger.log('本日は既に通知済みです: ' + todayKey);
    return;
  }

  try {
    validateWebhook_();

    const page = resolveSourcePage_(new Date());
    const result = extractEvents_(page.html, page.url);

    if (!result.structureOk) {
      throw new Error('羊飼いのFXブログのHTML構造を認識できませんでした: ' + page.url);
    }

    const events = sortEvents_(dedupeEvents_(result.events));
    postDiscord_(buildNormalPayload_(events, todayKey, page.url, result.sourceType));
    props.setProperty('LAST_NOTIFY_DATE', todayKey);
  } catch (e) {
    Logger.log((e && e.stack) ? e.stack : String(e));

    try {
      if (DISCORD_WEBHOOK_URL && DISCORD_WEBHOOK_URL.indexOf('discord.com/api/webhooks/') !== -1) {
        postDiscord_(buildErrorPayload_());
      }
      props.setProperty('LAST_NOTIFY_DATE', todayKey);
    } catch (notifyError) {
      Logger.log('Discordへのエラー通知にも失敗: ' + notifyError);
    }
  }
}

function resolveSourcePage_(date) {
  const ymd = Utilities.formatDate(date, TIME_ZONE, 'yyyyMMdd');
  const ym = Utilities.formatDate(date, TIME_ZONE, 'yyyyMM');
  const month = String(Number(Utilities.formatDate(date, TIME_ZONE, 'M')));
  const day = String(Number(Utilities.formatDate(date, TIME_ZONE, 'd')));

  const directUrl = SOURCE_BASE_URL + '/article/fxdays' + ymd + '.html';
  const direct = fetchPage_(directUrl);
  if (direct && isDailyArticle_(direct.html, month, day)) {
    return { html: direct.html, url: directUrl, type: 'daily' };
  }

  const monthUrl = SOURCE_BASE_URL + '/' + ym + '/';
  const monthPage = fetchPage_(monthUrl);
  if (monthPage) {
    const foundUrl = findDailyArticleUrl_(monthPage.html, month, day);
    if (foundUrl) {
      const found = fetchPage_(foundUrl);
      if (found && isDailyArticle_(found.html, month, day)) {
        return { html: found.html, url: foundUrl, type: 'daily-from-month' };
      }
    }
  }

  const weekUrl = SOURCE_BASE_URL + '/article/' + getWeekMondayYmd_(date) + 'weekfx.html';
  const weekly = fetchPage_(weekUrl);
  if (weekly && weekly.html.indexOf(month + '月' + day + '日') !== -1) {
    return { html: weekly.html, url: weekUrl, type: 'weekly' };
  }

  throw new Error('当日ページまたは直近週次ページを取得できませんでした。direct=' + directUrl);
}

function fetchPage_(url) {
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    followRedirects: true,
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Google Apps Script; daily fx indicator notifier)',
      'Accept-Language': 'ja,en;q=0.8',
    },
  });

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    Logger.log('Fetch failed: ' + code + ' ' + url);
    return null;
  }

  return { html: res.getContentText('UTF-8'), url: url };
}

function isDailyArticle_(html, month, day) {
  return html.indexOf(month + '月' + day + '日') !== -1 &&
    html.indexOf('為替相場の注目材料と指標ランク') !== -1;
}

function findDailyArticleUrl_(html, month, day) {
  const re = new RegExp('href=["\\\']([^"\\\']*fxdays\\d{8}\\.html)["\\\'][^>]*>[\\s\\S]{0,120}?' + month + '月' + day + '日', 'i');
  const m = html.match(re);
  if (!m) return null;
  return absoluteUrl_(m[1]);
}

function absoluteUrl_(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.charAt(0) === '/') return SOURCE_BASE_URL + url;
  return SOURCE_BASE_URL + '/' + url;
}

function getWeekMondayYmd_(date) {
  const isoDow = Number(Utilities.formatDate(date, TIME_ZONE, 'u')); // 月曜=1, 日曜=7
  const monday = new Date(date.getTime() - (isoDow - 1) * 24 * 60 * 60 * 1000);
  return Utilities.formatDate(monday, TIME_ZONE, 'yyyyMMdd');
}

function extractEvents_(html, url) {
  const must = parseMustWatchEvents_(html, url);
  if (must.events.length > 0) {
    return { events: must.events, structureOk: true, sourceType: 'must-watch' };
  }

  const table = parseCalendarTableEvents_(html, url);
  if (table.events.length > 0) {
    return { events: table.events, structureOk: true, sourceType: 'calendar-table' };
  }

  const weekly = parseWeeklyEvents_(html, url);
  if (weekly.events.length > 0) {
    return { events: weekly.events, structureOk: true, sourceType: 'weekly' };
  }

  return {
    events: [],
    structureOk: must.structureOk || table.structureOk || weekly.structureOk,
    sourceType: 'none',
  };
}

function parseMustWatchEvents_(html, url) {
  const start = html.indexOf('本日の必見イベント');
  if (start < 0) return { events: [], structureOk: false };

  const chunk = html.slice(start, start + 12000);
  const rows = chunk.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  let eventRow = '';

  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const text = htmlToText_(rows[i]);
    if (/・\s*(?:\d{1,2}時\d{2}分|未定|時間未定)/.test(text)) {
      eventRow = rows[i];
      break;
    }
  }

  if (!eventRow) return { events: [], structureOk: true };

  const lines = htmlToText_(eventRow)
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean);

  const events = [];
  lines.forEach(line => {
    const event = parseEventLine_(line, url, 'must-watch');
    if (event) events.push(event);
  });

  return { events: events, structureOk: true };
}

function parseCalendarTableEvents_(html, url) {
  const start = html.indexOf('c-shihyo-calendar');
  if (start < 0) return { events: [], structureOk: false };

  const end = html.indexOf('文字が、普通', start);
  const chunk = html.slice(start, end > start ? end : start + 70000);
  const rows = chunk.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const events = [];
  let currentTime = null;

  rows.forEach(row => {
    const cells = row.match(/<td\b[\s\S]*?<\/td>/gi) || [];
    if (cells.length === 0) return;

    const maybeTime = extractTimeFromText_(htmlToText_(cells[0]));
    if (maybeTime) currentTime = maybeTime;

    const country = extractCountryPrefix_(row);
    if (!country || !TARGET_COUNTRIES[country] || !currentTime) return;

    const rank = extractRank_(row);
    if (!isImportantRank_(country, rank, row)) return;

    const titleCell = findTitleCell_(cells);
    let name = htmlToText_(titleCell)
      .split('→')[0]
      .replace(new RegExp('^.*?' + country + '\\)'), '')
      .replace(/\[[^\]]+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!name) return;

    events.push(makeEvent_(currentTime, country, name, url, 'calendar-table', rank));
  });

  return { events: events, structureOk: rows.length > 0 };
}

function parseWeeklyEvents_(html, url) {
  const text = htmlToText_(html);
  const today = new Date();
  const month = String(Number(Utilities.formatDate(today, TIME_ZONE, 'M')));
  const day = String(Number(Utilities.formatDate(today, TIME_ZONE, 'd')));
  const re = new RegExp('(?:^|\\n)' + month + '\\/' + day + '\\s*\\n([\\s\\S]*?)(?=\\n\\d{1,2}\\/\\d{1,2}\\s*\\n|★月曜日|$)');
  const m = text.match(re);
  if (!m) return { events: [], structureOk: false };

  const lines = m[1].split(/\n+/).map(s => s.trim()).filter(Boolean);
  const events = [];
  let currentTime = null;

  lines.forEach(line => {
    const time = extractTimeFromText_(line);
    if (time) currentTime = time;

    if (!/^[米日英]\)/.test(line) && !/\s[米日英]\)/.test(line)) return;

    const normalized = currentTime ? currentTime.source + ' ' + line.replace(/^\d{1,2}:\d{2}\s*/, '') : line;
    const event = parseEventLine_(normalized, url, 'weekly');
    if (event) events.push(event);
  });

  return { events: events, structureOk: true };
}

function parseEventLine_(line, url, sourceType) {
  line = decodeHtml_(line)
    .replace(/^・\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  let m = line.match(/^(\d{1,2})(?:時|:)(\d{2})(?:分)?\s*[：:\s]\s*([米日英])\)\s*(.+)$/);
  if (m) {
    return makeEvent_(
      makeTime_(Number(m[1]), Number(m[2])),
      m[3],
      cleanName_(m[4]),
      url,
      sourceType,
      ''
    );
  }

  m = line.match(/^(?:時間未定|未定)\s*[：:\s]\s*([米日英])\)\s*(.+)$/);
  if (m) {
    return makeEvent_(
      { source: '未定', display: '時間未定', sort: 99999 },
      m[1],
      cleanName_(m[2]),
      url,
      sourceType,
      ''
    );
  }

  return null;
}

function makeEvent_(time, countryPrefix, name, url, sourceType, rank) {
  if (!TARGET_COUNTRIES[countryPrefix] || !name) return null;
  const target = TARGET_COUNTRIES[countryPrefix];

  return {
    time: time.display,
    sourceTime: time.source,
    sort: time.sort,
    country: target.label,
    currency: target.currency,
    name: cleanName_(name),
    sourceUrl: url,
    sourceType: sourceType,
    rank: rank || '',
  };
}

function makeTime_(hour, minute) {
  const source = pad2_(hour) + ':' + pad2_(minute);
  const display = hour >= 24
    ? '翌' + pad2_(hour - 24) + ':' + pad2_(minute)
    : pad2_(hour) + ':' + pad2_(minute);

  return { source: source, display: display, sort: hour * 60 + minute };
}

function extractTimeFromText_(text) {
  text = text.replace(/\s+/g, ' ').trim();
  let m = text.match(/(\d{1,2}):(\d{2})/);
  if (m) return makeTime_(Number(m[1]), Number(m[2]));

  m = text.match(/(\d{1,2})時(\d{2})分/);
  if (m) return makeTime_(Number(m[1]), Number(m[2]));

  if (/未定|時間未定/.test(text)) return { source: '未定', display: '時間未定', sort: 99999 };
  return null;
}

function extractCountryPrefix_(rowHtml) {
  if (/alt=["']米国["']/.test(rowHtml) || /米\)/.test(rowHtml)) return '米';
  if (/alt=["']日本["']/.test(rowHtml) || /日\)/.test(rowHtml)) return '日';
  if (/alt=["']英国["']/.test(rowHtml) || /英\)/.test(rowHtml)) return '英';
  return '';
}

function extractRank_(rowHtml) {
  const m = rowHtml.match(/icon-([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function isImportantRank_(countryPrefix, rank, rowHtml) {
  if (!rank) return false;

  const usImportant = { ss: true, s: true, aa: true, a: true, bb: true };
  const otherImportant = { maru2: true, maru: true };

  if (countryPrefix === '米') {
    if (usImportant[rank]) return true;
    return rank === 'b' && /pink|地区連銀経済報告|ベージュブック/.test(rowHtml);
  }

  return Boolean(otherImportant[rank]);
}

function findTitleCell_(cells) {
  for (let i = 0; i < cells.length; i++) {
    if (/class=["'][^"']*title/i.test(cells[i])) return cells[i];
  }
  return cells[2] || cells[cells.length - 1] || '';
}

function cleanName_(name) {
  return decodeHtml_(name)
    .replace(/<[^>]*>/g, '')
    .replace(/\s*→.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeEvents_(events) {
  const seen = {};
  return events.filter(e => {
    const key = e.time + '|' + e.currency + '|' + e.name;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function sortEvents_(events) {
  return events.sort((a, b) => a.sort - b.sort || a.currency.localeCompare(b.currency));
}

function buildNormalPayload_(events, todayKey, sourceUrl, sourceType) {
  const fields = [];

  if (events.length === 0) {
    fields.push({
      name: '対象イベント',
      value: '本日はUSD / JPY / GBPの高重要度イベントは見つかりませんでした。',
      inline: false
    });
  } else {
    events.slice(0, 25).forEach(function(e) {
      fields.push({
        name: e.time + ' JST | ' + e.currency + ' | ' + e.country,
        value: '**' + e.name + '**',
        inline: false
      });
    });
  }

  fields.push({
    name: '[警告] 取引禁止時間',
    value: '**' + WARNING_TEXT + '**',
    inline: false
  });

  return {
    username: 'FX重要指標通知',
    embeds: [{
      title: todayKey + ' 重要経済指標（USD / JPY / GBP）',
      url: sourceUrl,
      description: '取得元: 羊飼いのFXブログ' + String.fromCharCode(10) + '抽出方式: ' + sourceType,
      color: 15158332,
      fields: fields,
      footer: {
        text: '時刻はJST表記です。27:00などは翌03:00として表示しています。'
      },
      timestamp: new Date().toISOString()
    }]
  };
}

function buildErrorPayload_() {
  return {
    username: 'FX重要指標通知',
    embeds: [{
      title: '指標データの取得に失敗しました。',
      description: '本日は手動で確認してください',
      color: 0xE74C3C,
      timestamp: new Date().toISOString(),
    }],
  };
}

function postDiscord_(payload) {
  const res = UrlFetchApp.fetch(DISCORD_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Discord webhook failed: ' + code + ' ' + res.getContentText());
  }
}

function validateWebhook_() {
  if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL.indexOf('discord.com/api/webhooks/') === -1) {
    throw new Error('DISCORD_WEBHOOK_URLをDiscordのWebhook URLに差し替えてください。');
  }
}

function htmlToText_(html) {
  return decodeHtml_(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|li|table|tbody)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function decodeHtml_(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function pad2_(n) {
  return ('0' + n).slice(-2);
}
function getDiscordWebhookUrl_() {
  const url = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
  return url || '';
}
function checkMyWebhook() {
  const url = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
  Logger.log('=== 取得結果 ===');
  Logger.log(url);
}
