import { describe, expect, it } from 'vitest';
import { buildDownloadUrl, buildTemplateUrl, parseResourceUrl } from '../../src/main/services/resourceUrl.js';

const UUID = 'A1B2C3D4-E5F6-7890-ABCD-EF0123456789'; // 大写

describe('resourceUrl 边界补充', () => {
  it('UUID 大写可解析（正则大小写不敏感）', () => {
    expect(parseResourceUrl(buildDownloadUrl(UUID, 'a.docx'))).toMatchObject({ jobId: UUID });
  });

  it('文件名长度边界：255 可解析，256 拒绝', () => {
    const n255 = '名'.repeat(255);
    expect(n255.length).toBe(255);
    expect(parseResourceUrl(buildDownloadUrl(UUID, n255))?.kind).toBe('download');
    const n256 = '名'.repeat(256);
    expect(n256.length).toBe(256);
    expect(parseResourceUrl(buildDownloadUrl(UUID, n256))).toBeNull();
  });

  it('URL 编码特例：%25、%2B 往返无损', () => {
    for (const name of ['100%25.docx', 'a+b.docx', '空 格.docx']) {
      expect(parseResourceUrl(buildDownloadUrl(UUID, name))).toEqual({ kind: 'download', jobId: UUID, name });
    }
  });

  it('控制字符与 NUL 注入拒绝', () => {
    expect(parseResourceUrl(`md2word://download/${'a1b2c3d4-e5f6-7890-abcd-ef0123456789'}/a%00b.docx`)).toBeNull();
  });
});

describe('template URL（模板文件下载）', () => {
  it('合法 id 解析（含中文）', () => {
    expect(parseResourceUrl('md2word://template/builtin-zh')).toEqual({ kind: 'template', id: 'builtin-zh' });
    expect(parseResourceUrl(buildTemplateUrl('我的模板'))).toEqual({ kind: 'template', id: '我的模板' });
    expect(parseResourceUrl(buildTemplateUrl('pandoc-default'))).toEqual({ kind: 'template', id: 'pandoc-default' });
  });

  it('拒绝穿越/多余段/空 id', () => {
    expect(parseResourceUrl('md2word://template/..%2Fetc')).toBeNull();
    expect(parseResourceUrl('md2word://template/a/b')).toBeNull();
    expect(parseResourceUrl('md2word://template/')).toBeNull();
  });
});
