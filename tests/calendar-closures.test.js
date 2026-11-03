import assert from 'node:assert/strict';
import test from 'node:test';
import { closureBioFromCalendar } from '../src/classifier.js';
import { selectCalendarImageCandidate } from '../src/scraper.js';

const monday = day => ({ day, weekday: 'Mon', label: '', kind: 'weekly' });
const closed = (day, weekday, label) => ({ day, weekday, label, kind: 'special' });
const calendar = (calendarMonth, shadedDays) => ({
  isCalendarImage: true, calendarMonth, shadedDays
});

test('August dark cells yield only the two special closure dates', () => {
  const bio = closureBioFromCalendar(calendar(8, [
    ...[3, 10, 17, 24].map(monday),
    closed(13, 'Thu', '清潔消毒休館'),
    closed(18, 'Tue', '員工內訓休館')
  ]), 8);
  assert.equal(bio, '8/13 清潔消毒休館、8/18 員工內訓休館');
});

test('September dark visit block is a special closure even without the word 休館', () => {
  const shadedDays = [
    ...[7, 14, 21, 28].map(monday),
    closed(22, 'Tue', '聯合參訪'),
    closed(25, 'Fri', '中秋節休館'),
    closed(29, 'Tue', '教師節補休')
  ];
  assert.equal(closureBioFromCalendar(calendar(9, shadedDays), 9),
    '9/22 聯合參訪（休館）、9/25 中秋節休館、9/29 教師節補休');
});

test('unreadable date cell remains a review stop', () => {
  const shadedDays = [
    ...[7, 14, 21, 28].map(monday),
    { day: 22, weekday: 'Tue', label: '看不清楚', kind: 'uncertain' }
  ];
  assert.throws(() => closureBioFromCalendar(calendar(9, shadedDays), 9), /人工確認/);
});

test('October gray cells include closures absent from post prose', () => {
  const bio = closureBioFromCalendar(calendar(10, [
    ...[5, 12, 19, 26].map(monday),
    closed(9, 'Fri', '打蠟休館'),
    closed(10, 'Sat', '國慶休館'),
    closed(27, 'Tue', '光復補假')
  ]), 10);
  assert.equal(bio, '10/9 打蠟休館、10/10 國慶休館、10/27 光復補假');
});

test('wrong month or missing Monday grid is rejected', () => {
  assert.throws(() => closureBioFromCalendar(calendar(8, [monday(3), monday(10), monday(17)]), 9), /不是 9 月課表/);
  assert.throws(() => closureBioFromCalendar(calendar(10, [closed(9, 'Fri', '打蠟休館')]), 10), /星期一灰色格/);
});

test('image selector stays inside plausible calendar candidates', () => {
  const background = { src: 'https://scontent.example/bg.jpg', alt: '', width: 2000, height: 1414 };
  const calendarImage = { src: 'https://scontent.example/calendar.jpg', alt: '10月活動表', width: 1280, height: 720 };
  assert.equal(selectCalendarImageCandidate([background, calendarImage], 10)?.src, calendarImage.src);
  assert.equal(selectCalendarImageCandidate([calendarImage, { ...calendarImage, src: 'https://scontent.example/other.jpg' }], 10), null);
});
