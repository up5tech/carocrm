/**
 * Malware scanning hook (PLAN §25 "malware scanning hook").
 *
 * The attachment module runs every upload through a {@link MalwareScanner} before the file is
 * visible to anyone. The built-in {@link SignatureScanner} catches the EICAR test file, executable
 * containers smuggled in under a benign MIME type and NUL bytes in declared text — the cheap checks
 * that need no external service. An installation with ClamAV (or anything else) supplies its own
 * implementation behind the same token; scanning never blocks on network I/O here.
 */
export interface ScanInput {
  /** Storage key the bytes will be (or were) written to. */
  key: string;
  name: string;
  mimeType: string;
  /** First bytes of the file, enough to read magic numbers. */
  head: Buffer;
  size: number;
}

export interface ScanResult {
  clean: boolean;
  provider: string;
  reason?: string | undefined;
}

export interface MalwareScanner {
  readonly name: string;
  scan(input: ScanInput): Promise<ScanResult>;
}

/** How many leading bytes the API reads for sniffing; signatures live in the head. */
export const SNIFF_BYTES = 8_192;

/** EICAR test file — the harmless string every AV vendor recognises. */
export const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const EXECUTABLE_SIGNS: readonly { name: string; test: (head: Buffer) => boolean }[] = [
  { name: 'PE/Windows executable', test: (head) => head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a },
  { name: 'ELF binary', test: (head) => head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46 },
  { name: 'Java class', test: (head) => head.length >= 4 && head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && head[3] === 0xbe },
  { name: 'Mach-O binary', test: (head) => head.length >= 4 && head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe },
  { name: 'shebang script', test: (head) => head.length >= 2 && head[0] === 0x23 && head[1] === 0x21 },
];

const IMAGE_SIGNS: readonly ((head: Buffer) => boolean)[] = [
  (head) => head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47,
  (head) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  (head) => head.length >= 6 && head.subarray(0, 3).toString('latin1') === 'GIF',
  (head) => head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP',
  (head) => head.length >= 5 && head.subarray(0, 5).toString('latin1') === '<?xml',
];

const CONTAINER_MIME_PREFIXES: readonly string[] = [
  'application/zip',
  'application/x-zip',
  'application/vnd.openxmlformats',
  'application/msword',
  'application/vnd.ms-',
  'application/pdf',
  'application/octet-stream',
];

export class NoopScanner implements MalwareScanner {
  readonly name = 'none';

  async scan(): Promise<ScanResult> {
    return { clean: true, provider: this.name };
  }
}

export class SignatureScanner implements MalwareScanner {
  readonly name = 'signature';

  async scan(input: ScanInput): Promise<ScanResult> {
    const head = input.head;
    const text = head.subarray(0, Math.min(head.length, 2_048)).toString('latin1');
    if (text.includes(EICAR_SIGNATURE)) {
      return { clean: false, provider: this.name, reason: 'EICAR test signature detected' };
    }

    const declared = input.mimeType.toLowerCase();
    const executable = EXECUTABLE_SIGNS.find((sign) => sign.test(head));
    if (executable && !declared.startsWith('image/') && !allowsExecutablePayload(declared)) {
      return { clean: false, provider: this.name, reason: `${executable.name} signature in a "${input.mimeType}" file` };
    }

    if (declared.startsWith('text/') && head.includes(0)) {
      return { clean: false, provider: this.name, reason: 'NUL byte inside a text file' };
    }

    if (declared.startsWith('image/') && !IMAGE_SIGNS.some((test) => test(head))) {
      return { clean: false, provider: this.name, reason: `declared as "${input.mimeType}" but the content is not an image` };
    }

    return { clean: true, provider: this.name };
  }
}

/** Office/PDF containers legitimately carry binary payloads; only extensions decide here. */
function allowsExecutablePayload(declared: string): boolean {
  return CONTAINER_MIME_PREFIXES.some((prefix) => declared.startsWith(prefix));
}

/** Runs every scanner in order; the first rejection wins and a broken scanner fails closed. */
export class CompositeScanner implements MalwareScanner {
  readonly name: string;

  constructor(private readonly scanners: readonly MalwareScanner[]) {
    this.name = scanners.map((scanner) => scanner.name).join('+') || 'none';
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    for (const scanner of this.scanners) {
      try {
        const result = await scanner.scan(input);
        if (!result.clean) {
          return { clean: false, provider: scanner.name, ...(result.reason === undefined ? {} : { reason: result.reason }) };
        }
      } catch (error: unknown) {
        return {
          clean: false,
          provider: scanner.name,
          reason: `scanner failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return { clean: true, provider: this.name };
  }
}
