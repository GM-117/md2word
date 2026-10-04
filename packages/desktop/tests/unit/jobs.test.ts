import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { JobRegistry } from '../../src/main/services/jobs.js';

describe('JobRegistry（open:path 白名单）', () => {
  it('登记的产物可解析（登记键 → 产物路径 + 所在目录）', () => {
    const reg = new JobRegistry();
    const jobId = reg.createJob('/jobs/j1');
    reg.addOutput(jobId, '报告.docx', '/src/报告.docx');
    expect(reg.resolve(jobId, '报告.docx')).toEqual({ outputPath: '/src/报告.docx', folder: '/src' });
    expect(reg.resolveKey(jobId, '报告.docx')).toBe('/src/报告.docx');
  });

  it('未登记 jobId / 名称一律拒绝（防穿越的根本机制：用户输入不参与路径拼接）', () => {
    const reg = new JobRegistry();
    const jobId = reg.createJob('/jobs/j1');
    reg.addOutput(jobId, 'a.docx', '/src/a.docx');
    expect(reg.resolve('no-such-job', 'a.docx')).toBeNull();
    expect(reg.resolve(jobId, '../../etc/passwd')).toBeNull();
    expect(reg.resolve(jobId, 'a.docx/../../x')).toBeNull();
    expect(reg.resolveKey(jobId, 'nope.docx')).toBeNull();
    expect(reg.resolveKey('no-such-job', 'a.docx')).toBeNull();
  });

  it('同一作业内同名键后写覆盖先写（M6 重试重新登记取最新产物）', () => {
    const reg = new JobRegistry();
    const jobId = reg.createJob('/jobs/j3');
    reg.addOutput(jobId, 'a.docx', '/src/old.docx');
    reg.addOutput(jobId, 'a.docx', '/src/new.docx');
    expect(reg.resolveKey(jobId, 'a.docx')).toBe('/src/new.docx');
  });

  it('jobDir 返回 staged 作业目录', () => {
    const reg = new JobRegistry();
    const jobId = reg.createJob(join('/jobs', 'j2'));
    expect(reg.jobDir(jobId)).toBe(join('/jobs', 'j2'));
    expect(reg.jobDir('missing')).toBeNull();
  });
});
