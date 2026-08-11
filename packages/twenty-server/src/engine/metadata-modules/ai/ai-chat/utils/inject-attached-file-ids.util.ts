import {
  isExtendedFileUIPart,
  type ExtendedFileUIPart,
  type ExtendedUIMessage,
} from 'twenty-shared/ai';

// The model can see an attached image but has no way to name it to a tool. The
// file part carries a signed URL it never reads back as text, and the uploaded
// files prompt section lists only what the code interpreter took, which is
// spreadsheets. So an image, a video or a PDF reaches the model with no
// referenceable id at all.
//
// The reference goes on the message that carried the file rather than into the
// system prompt, so it stays correct across turns: a prompt section only ever
// describes the newest upload, and the model cannot tell which turn it belongs
// to once a second file arrives.

const describeAttachedFile = (part: ExtendedFileUIPart): string => {
  const filename = part.filename?.trim();
  const label =
    filename !== undefined && filename !== '' ? filename : 'attachment';

  // The storage path is given verbatim so nothing has to be assembled or
  // guessed. Without it the model invents a plausible-looking file URL, which
  // is worse than having no reference at all: it looks right and resolves to
  // nothing.
  const storagePath =
    part.storagePath !== undefined && part.storagePath !== ''
      ? `\n  storage path: \`${part.storagePath}\``
      : '';

  return `- \`${label}\` (${part.mediaType}) id: \`${part.fileId}\`${storagePath}`;
};

export const injectAttachedFileIds = (
  messages: ExtendedUIMessage[],
): ExtendedUIMessage[] =>
  messages.map((message) => {
    if (message.role !== 'user') {
      return message;
    }

    const fileParts = message.parts.filter((part) =>
      isExtendedFileUIPart(part as unknown as Record<string, unknown>),
    ) as ExtendedFileUIPart[];

    if (fileParts.length === 0) {
      return message;
    }

    const referencePart = {
      type: 'text' as const,
      text: `<attached_files>
Files attached to this message. Use these values exactly as given. Never
construct a file URL or a path yourself: one that looks right but is invented
resolves to nothing.
${fileParts.map(describeAttachedFile).join('\n')}
</attached_files>`,
    };

    // Appended, not prepended: the ids are a footnote to what the user wrote,
    // and putting them first reads as though the user asked about the files.
    return {
      ...message,
      parts: [...message.parts, referencePart],
    };
  });
