import assert from 'node:assert/strict';
import test from 'node:test';
import { assignUpdatesToDateSlots } from '../src/classifier.js';

const slot = (key, title, active = true, collectionTitle = '外聘課程') => ({
  key, id: key, title, active, collectionTitle,
  month: Number(title.match(/^\d+/)?.[0] || 0)
});
const activity = (key, title, url, collectionTitle = '外聘課程') => ({
  planKey: key, id: key, currentTitle: '', collectionTitle,
  type: 'link', action: 'update', newTitle: title, newUrl: url
});

test('reuses visible card positions in date order and hides old unused cards', () => {
  const candidates = [slot('A', '9/3舊課'), slot('B', '9/5舊課'), slot('C', '9/7舊課')];
  const updates = [
    activity('C', '10/24新課', 'https://example.com/24'),
    activity('A', '10/2新課', 'https://example.com/2')
  ];
  const result = assignUpdatesToDateSlots(updates, candidates, 10);
  assert.deepEqual(result.map(item => [item.id, item.newTitle, item.action]), [
    ['A', '10/2新課', 'update'],
    ['B', '10/24新課', 'update'],
    ['C', '9/7舊課', 'toggle_off']
  ]);
  assert.deepEqual(result.slice(0, 2).map(item => item.newUrl), [
    'https://example.com/2', 'https://example.com/24'
  ]);
});

test('extra special activity is appended after existing sorted slots', () => {
  const candidates = [slot('S1', '9/1舊活動', true, '特別活動')];
  const updates = [
    activity('S1', '10/20特別活動', 'https://example.com/20', '特別活動'),
    { ...activity('NEW-SPECIAL-1', '10/17特別活動', 'https://example.com/17', '特別活動'), id: '', action: 'add' }
  ];
  const result = assignUpdatesToDateSlots(updates, candidates, 10);
  assert.deepEqual(result.map(item => [item.id, item.newTitle, item.action]), [
    ['S1', '10/17特別活動', 'update'],
    ['', '10/20特別活動', 'add']
  ]);
  assert.equal(new Set(result.map(item => item.planKey)).size, result.length);
});

test('stops when a regular collection has too few slots', () => {
  assert.throws(() => assignUpdatesToDateSlots([
    activity('A', '10/2課', 'https://example.com/2'),
    activity('B', '10/3課', 'https://example.com/3')
  ], [slot('A', '9/2舊課')], 10), /只有 1 張卡片/);
});

test('stops before hiding an unaccounted current-month activity', () => {
  assert.throws(() => assignUpdatesToDateSlots(
    [activity('A', '10/2新課', 'https://example.com/2')],
    [slot('A', '10/1現有課'), slot('B', '10/3未對應課')],
    10
  ), /未對應的有效卡片/);
});
