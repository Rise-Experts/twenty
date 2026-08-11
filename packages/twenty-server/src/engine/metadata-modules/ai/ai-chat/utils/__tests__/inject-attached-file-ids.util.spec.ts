import { type ExtendedUIMessage } from 'twenty-shared/ai';

import { injectAttachedFileIds } from 'src/engine/metadata-modules/ai/ai-chat/utils/inject-attached-file-ids.util';

const buildFilePart = (
  mediaType: string,
  fileId: string,
  filename?: string,
) => ({
  type: 'file' as const,
  mediaType,
  filename,
  url: 'https://crm.example.de/file/agent-chat/abc?token=x',
  fileId,
});

const buildTextPart = (text: string) => ({ type: 'text' as const, text });

const buildMessage = (
  role: ExtendedUIMessage['role'],
  parts: ExtendedUIMessage['parts'],
): ExtendedUIMessage => ({ id: 'message-id', role, parts });

const lastText = (message: ExtendedUIMessage): string => {
  const part = message.parts[message.parts.length - 1];

  return part.type === 'text' ? part.text : '';
};

describe('injectAttachedFileIds', () => {
  it('appends the id of an attached image', () => {
    const messages = [
      buildMessage('user', [
        buildTextPart('post this'),
        buildFilePart('image/jpeg', 'file-1', 'holiday.jpg'),
      ]),
    ];

    const result = injectAttachedFileIds(messages);

    expect(lastText(result[0])).toContain('`holiday.jpg` (image/jpeg)');
    expect(lastText(result[0])).toContain('`file-1`');
  });

  it.each([
    ['video/mp4', 'reel.mp4'],
    ['application/pdf', 'brief.pdf'],
    ['audio/mpeg', 'voice.mp3'],
  ])('appends the id for %s', (mediaType, filename) => {
    const messages = [
      buildMessage('user', [buildFilePart(mediaType, 'file-9', filename)]),
    ];

    const result = injectAttachedFileIds(messages);

    expect(lastText(result[0])).toContain(`\`${filename}\` (${mediaType})`);
    expect(lastText(result[0])).toContain('`file-9`');
  });

  it('lists every attached file', () => {
    const messages = [
      buildMessage('user', [
        buildFilePart('image/png', 'file-1', 'a.png'),
        buildFilePart('video/mp4', 'file-2', 'b.mp4'),
      ]),
    ];

    const text = lastText(injectAttachedFileIds(messages)[0]);

    expect(text).toContain('`file-1`');
    expect(text).toContain('`file-2`');
  });

  // The reference is a footnote to what the user wrote. Leading with it reads
  // as though the user asked about the files.
  it('appends rather than prepends, leaving the original parts in place', () => {
    const messages = [
      buildMessage('user', [
        buildTextPart('post this'),
        buildFilePart('image/png', 'file-1', 'a.png'),
      ]),
    ];

    const result = injectAttachedFileIds(messages);

    expect(result[0].parts).toHaveLength(3);
    expect(result[0].parts[0]).toEqual(buildTextPart('post this'));
  });

  it('leaves a message with no attachments untouched', () => {
    const messages = [buildMessage('user', [buildTextPart('hello')])];

    expect(injectAttachedFileIds(messages)).toEqual(messages);
  });

  it('leaves assistant messages untouched', () => {
    const messages = [
      buildMessage('assistant', [
        buildFilePart('image/png', 'file-1', 'a.png'),
      ]),
    ];

    expect(injectAttachedFileIds(messages)).toEqual(messages);
  });

  it('falls back to a label when the file has no filename', () => {
    const messages = [
      buildMessage('user', [buildFilePart('image/png', 'file-1')]),
    ];

    expect(lastText(injectAttachedFileIds(messages)[0])).toContain(
      '`attachment` (image/png)',
    );
  });
});
