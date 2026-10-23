import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractText, loadMaterial, materialKeyterms, materialsBlock } from '../src/core/materials';

const fx = (f: string) => join(__dirname, 'fixtures', f);

describe('Materials (resume, cover letter, job posting)', () => {
  it('reads a Word resume', async () => {
    const m = await loadMaterial('resume', fx('sample-resume.docx'), readFileSync(fx('sample-resume.docx')));
    expect(m.text).toContain('Acme Retail');
    expect(m.text).toContain('GPA 3.40');
    expect(m.words).toBeGreaterThan(40);
  });

  it('reads a PDF resume', async () => {
    const m = await loadMaterial('resume', fx('sample-resume.pdf'), readFileSync(fx('sample-resume.pdf')));
    expect(m.text).toContain('Acme Retail');
    expect(m.text).toContain('52 volunteers');
  });

  it('reads a plain-text job posting', async () => {
    const m = await loadMaterial('posting', fx('sample-posting.txt'), readFileSync(fx('sample-posting.txt')));
    expect(m.text).toContain('Operations Practice');
  });

  it('rejects unsupported files', async () => {
    await expect(extractText('resume.xlsx', new Uint8Array([1, 2, 3]))).rejects.toThrow(/Unsupported file type/);
  });

  it('builds a labeled grounding block and transcription keyterms', async () => {
    const resume = await loadMaterial('resume', fx('sample-resume.docx'), readFileSync(fx('sample-resume.docx')));
    const posting = await loadMaterial('posting', fx('sample-posting.txt'), readFileSync(fx('sample-posting.txt')));
    const block = materialsBlock({ resume, posting });
    expect(block).toMatch(/^=== RESUME ===/);
    expect(block).toContain('=== JOB POSTING ===');
    const terms = materialKeyterms({ resume, posting });
    expect(terms).toContain('Acme Retail');
    expect(terms).toContain('SQL');
  });
});
