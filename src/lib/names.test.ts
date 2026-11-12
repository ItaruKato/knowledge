import { describe, expect, it } from 'vitest';
import { officialName } from './names';

describe('正式な会社名', () => {
  it('HP の正式名を使う（法人格を含み、同じ会社のときだけ。末尾の英語名は外す）', () => {
    expect(officialName('ナハト', { web: { state: 'done', officialName: { value: '株式会社ナハト（Nahato Inc.）' } } })).toBe('株式会社ナハト');
    expect(officialName('ナハト', { web: { state: 'done', officialName: { value: 'ナハト' } } })).toBeNull();
    expect(officialName('ナハト', { web: { state: 'done', officialName: { value: '株式会社まったく別' } } })).toBeNull();
  });
  it('HP になければ gBizINFO の正式名、どちらもなければ null', () => {
    expect(officialName('SkySense', { gbiz: { name: 'SkySense株式会社' } })).toBe('SkySense株式会社');
    expect(officialName('ナハト', { web: { state: 'nosite' } })).toBeNull();
    expect(officialName('ナハト', undefined)).toBeNull();
  });
});
