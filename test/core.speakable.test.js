'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { speakable, words, ordinal } = require('../main/speakable');
const tts = require('../main/tts');

test('speakable: times, money, titles, ordinals, percents, years, codes', () => {
  assert.equal(speakable('Dr. Smith will see you at 3:45 pm.'), 'Doctor Smith will see you at three forty-five P M');
  assert.equal(speakable('It costs $20, or $1.50 each.'), 'It costs twenty dollars, or one dollar fifty each.');
  assert.equal(speakable('We won 1st place, 50% of 120 people!'), 'We won first place, fifty percent of one hundred twenty people!');
  assert.equal(speakable('Back in 1999, and 2024.'), 'Back in nineteen ninety-nine, and two thousand twenty-four.');
  assert.equal(speakable('Agent 007 & Mr. Kim, 3:05.'), 'Agent zero zero seven and Mister Kim, three oh five.');
  assert.equal(speakable('Hello there.'), 'Hello there.', 'ordinary lines are untouched');
  assert.equal(words(101), 'one hundred one');
  assert.equal(ordinal(22), 'twenty-second');
  assert.equal(ordinal(40), 'fortieth');
  assert.equal(words(1234567), '1234567', 'very large numbers stay digits');
});

test('only the fast model gets the spelled-out text', () => {
  assert.equal(tts.buildRequest({ text: 'At 3:45.', voice_id: 'a' }).body.text, 'At three forty-five.');
  assert.equal(tts.buildRequest({ text: 'At 3:45.', voice_id: 'a', model: tts.BEST_MODEL }).body.text, 'At 3:45.');
});
