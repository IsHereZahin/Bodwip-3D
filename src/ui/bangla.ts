import { SYNODIC_MONTH } from '../env/astro';
import type { SkyEventKind } from '../env/clock';

const DIGITS = '০১২৩৪৫৬৭৮৯';

/** Western digits to Bangla ones. */
export function bn(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => DIGITS[Number(d)]);
}

/**
 * The part of the day as it is spoken. The boundaries follow this sky, whose sun sets at about
 * 18:14, so "সন্ধ্যা" begins with the sunset.
 */
function partOfDay(hour: number): string {
  if (hour < 4) return 'রাত';
  if (hour < 6) return 'ভোর';
  if (hour < 12) return 'সকাল';
  if (hour < 15) return 'দুপুর';
  if (hour < 18.2) return 'বিকেল';
  if (hour < 20) return 'সন্ধ্যা';
  return 'রাত';
}

/** "সন্ধ্যা ৬:১৪": a twelve-hour clock with the part of the day. */
export function clockLabel(hour: number): string {
  const minutes = Math.floor(hour * 60) % 1440;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${partOfDay(minutes / 60)} ${bn(h % 12 || 12)}:${bn(String(m).padStart(2, '0'))}`;
}

const TITHI = ['প্রতিপদ', 'দ্বিতীয়া', 'তৃতীয়া', 'চতুর্থী', 'পঞ্চমী', 'ষষ্ঠী', 'সপ্তমী', 'অষ্টমী', 'নবমী', 'দশমী', 'একাদশী', 'দ্বাদশী', 'ত্রয়োদশী', 'চতুর্দশী'];

/** The lunar day as a Bangla calendar names it, e.g. "কৃষ্ণপক্ষ · দ্বিতীয়া". */
/**
 * The tide in words, from its current (`flow`: + ebbing, − flooding, as a share of a spring tide's strongest)
 * and the sea's level (m): rising, falling, or slack at high or low water.
 */
export function tideLabel(flow: number, level: number): string {
  if (Math.abs(flow) < 0.1) return level > 0 ? 'ভরা জোয়ার' : 'ভাটার শেষ';
  return flow < 0 ? 'জোয়ার' : 'ভাটা';
}

export function tithiLabel(age: number): string {
  const n = Math.floor((age / SYNODIC_MONTH) * 30) % 30;
  if (n === 14) return 'পূর্ণিমা';
  if (n === 29) return 'অমাবস্যা';
  return n < 15 ? `শুক্লপক্ষ · ${TITHI[n]}` : `কৃষ্ণপক্ষ · ${TITHI[n - 15]}`;
}

/** Eight phases a viewer can pick, each with the moon's age in days. */
export const MOON_PHASES: readonly { age: number; name: string }[] = [
  { age: 0.5, name: 'অমাবস্যা' },
  { age: 3.7, name: 'বাঁকা চাঁদ (শুক্লপক্ষ)' },
  { age: 7.4, name: 'আধখানা চাঁদ (শুক্লপক্ষ)' },
  { age: 11.1, name: 'প্রায় পূর্ণ (শুক্লপক্ষ)' },
  { age: 14.8, name: 'পূর্ণিমা' },
  { age: 18.5, name: 'প্রায় পূর্ণ (কৃষ্ণপক্ষ)' },
  { age: 22.1, name: 'আধখানা চাঁদ (কৃষ্ণপক্ষ)' },
  { age: 25.8, name: 'বাঁকা চাঁদ (কৃষ্ণপক্ষ)' },
];

/** Index into MOON_PHASES of the phase nearest this age. */
export function nearestPhase(age: number): number {
  return Math.round((age / SYNODIC_MONTH) * MOON_PHASES.length) % MOON_PHASES.length;
}

export const EVENT_NAME: Record<SkyEventKind, string> = {
  sunrise: 'সূর্যোদয়',
  sunset: 'সূর্যাস্ত',
  moonrise: 'চন্দ্রোদয়',
  moonset: 'চন্দ্রাস্ত',
};

/** What is happening now, for the notice that announces it. */
export const EVENT_NOW: Record<SkyEventKind, string> = {
  sunrise: 'সূর্য উঠছে',
  sunset: 'সূর্য ডুবছে',
  moonrise: 'চাঁদ উঠছে',
  moonset: 'চাঁদ ডুবছে',
};
