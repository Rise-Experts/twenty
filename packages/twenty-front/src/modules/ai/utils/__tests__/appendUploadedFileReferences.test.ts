import { appendUploadedFileReferences } from '@/ai/utils/appendUploadedFileReferences';
import { type AgentChatFileUIPart } from '@/ai/types/agent-chat-file-ui-part.type';

const makeFile = (
  overrides: Partial<AgentChatFileUIPart>,
): AgentChatFileUIPart => ({
  type: 'file',
  filename: 'report.pdf',
  mediaType: 'application/pdf',
  url: 'https://example.test/file/AgentChat/id?token=short-lived',
  fileId: 'file-1',
  ...overrides,
});

describe('appendUploadedFileReferences', () => {
  it('should return the original text unchanged when there are no files', () => {
    expect(appendUploadedFileReferences('hello', [])).toBe('hello');
  });

  it('should append a fileid-link reference for a single file', () => {
    const result = appendUploadedFileReferences('hello', [
      makeFile({ filename: 'a.pdf', fileId: 'id-1' }),
    ]);

    expect(result).toBe('hello\n\nAttached files:\n- [a.pdf](fileid:id-1)');
  });

  it('should list every uploaded file on its own line', () => {
    const result = appendUploadedFileReferences('hi', [
      makeFile({ filename: 'a.pdf', fileId: 'id-1' }),
      makeFile({ filename: 'b.png', fileId: 'id-2' }),
    ]);

    expect(result).toBe(
      'hi\n\nAttached files:\n- [a.pdf](fileid:id-1)\n- [b.png](fileid:id-2)',
    );
  });

  it('should keep the fileId in the source but not the expiring signed url', () => {
    const result = appendUploadedFileReferences('hi', [
      makeFile({
        fileId: 'id-9',
        url: 'https://example.test/file/AgentChat/id?token=secret',
      }),
    ]);

    expect(result).toContain('fileid:id-9');
    expect(result).not.toContain('token=secret');
  });
});
