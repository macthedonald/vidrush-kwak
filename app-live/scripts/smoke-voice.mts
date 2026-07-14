// Unit smoke: the two pure functions that determine audio↔video sync.
// 1) groupCharsIntoWords: ElevenLabs char alignment → word timings.
// 2) bindVoiceTimings: shots tile [0, audioEnd] at each shot's first spoken word,
//    pauses fold into the preceding shot, captions keep absolute voice times, no drift.
import { bindVoiceTimings } from '../lib/engine/beats'
import { groupCharsIntoWords, type VoiceWord } from '../lib/engine/voice'

// --- 1) char grouping ---
const text = 'Hi there!'
const chars = text.split('')
const starts = chars.map((_, i) => +(i * 0.1).toFixed(2))
const ends = chars.map((_, i) => +((i + 1) * 0.1).toFixed(2))
const words = groupCharsIntoWords(chars, starts, ends)
console.log('WORDS:', JSON.stringify(words))
const ok1 =
  words.length === 2 &&
  words[0].word === 'Hi' &&
  words[1].word === 'there!' &&
  Math.abs(words[0].start - 0) < 1e-9 &&
  Math.abs(words[1].end - 0.9) < 1e-9
console.log('1) grouping ok:', ok1)

// --- 2) real bindVoiceTimings ---
const cores = [
  { narration: 'Ever wondered?', kind: 'photo' as const, visualQuery: 'q1', visualIntent: 'i1' },
  { narration: 'The answer.', kind: 'video' as const, visualQuery: 'q2', visualIntent: 'i2' }
]
const voiceWords: VoiceWord[] = [
  { word: 'Ever', start: 0.05, end: 0.32 },
  { word: 'wondered?', start: 0.32, end: 1.0 },
  { word: 'The', start: 1.4, end: 1.6 }, // 0.4s pause before this shot
  { word: 'answer.', start: 1.6, end: 2.3 }
]
const shots = bindVoiceTimings(cores, voiceWords)
console.log('SHOTS:', JSON.stringify(shots.map(s => ({ start: s.start, duration: s.duration, w: s.words.length }))))

const audioEnd = 2.3
const sumDur = shots[0].duration + shots[1].duration
const ok2 =
  shots.length === 2 &&
  shots[0].start === 0 &&
  Math.abs(shots[0].duration - 1.4) < 1e-6 && // pause folded into shot 0
  Math.abs(shots[1].start - 1.4) < 1e-6 &&
  Math.abs(shots[1].duration - 0.9) < 1e-6 &&
  Math.abs(sumDur - audioEnd) < 1e-6 && // video length locks to audio, no drift
  shots[0].words.length === 2 &&
  shots[1].words.length === 2 &&
  shots[0].words[0].start === 0.05 // captions keep ABSOLUTE voice times
console.log('2) bindVoiceTimings ok (tiles to audioEnd, absolute captions):', ok2)

// leftover-words safety: extra voice words fold into the last shot
const shots2 = bindVoiceTimings(cores, [...voiceWords, { word: 'extra', start: 2.3, end: 2.6 }])
const ok3 = shots2[1].words.length === 3 && Math.abs(shots2[1].start + shots2[1].duration - 2.6) < 1e-6
console.log('3) leftover words folded into last shot:', ok3)

console.log(ok1 && ok2 && ok3 ? '\nALL VOICE SMOKE CHECKS PASSED' : '\nFAILED')
