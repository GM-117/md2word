import { describe, expect, it } from 'vitest';
import { buildDownloadUrl, parseResourceUrl } from '../../src/main/services/resourceUrl.js';

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

describe('parseResourceUrl', () => {
  it('解析合法 download URL（中文/emoji 名）', () => {
    const url = buildDownloadUrl(UUID, '中文 文档.docx');
    expect(parseResourceUrl(url)).toEqual({ kind: 'download', jobId: UUID, name: '中文 文档.docx' });
  });

  it('解析合法 log URL', () => {
    expect(parseResourceUrl('md2word://log/export')).toEqual({ kind: 'log' });
  });

  it('拒绝非 md2word 协议', () => {
    expect(parseResourceUrl('https://example.com/x')).toBeNull();
    expect(parseResourceUrl('file:///etc/passwd')).toBeNull();
  });

  it('拒绝非法 UUID', () => {
    expect(parseResourceUrl('md2word://download/xxx/abc.docx')).toBeNull();
    expect(parseResourceUrl('md2word://download/../../etc/abc.docx')).toBeNull();
  });

  it('拒绝路径穿越与分隔符', () => {
    expect(parseResourceUrl(`md2word://download/${UUID}/..%2F..%2Fetc.docx`)).toBeNull();
    expect(parseResourceUrl(`md2word://download/${UUID}/a%2Fb.docx`)).toBeNull();
    expect(parseResourceUrl(`md2word://download/${UUID}/a%5Cb.docx`)).toBeNull();
  });

  it('拒绝多余段与空名', () => {
    expect(parseResourceUrl(`md2word://download/${UUID}/a.docx/extra`)).toBeNull();
    expect(parseResourceUrl(`md2word://download/${UUID}`)).toBeNull();
    expect(parseResourceUrl(`md2word://download/${UUID}/`)).toBeNull();
  });

  it('拒绝非法 URL 与其他 host', () => {
    expect(parseResourceUrl('not a url')).toBeNull();
    expect(parseResourceUrl(`md2word://other/${UUID}/a.docx`)).toBeNull();
  });
});
