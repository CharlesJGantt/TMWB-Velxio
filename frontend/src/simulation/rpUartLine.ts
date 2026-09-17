/**
 * rpUartLine — the line a PL011 UART (rp2040js / rp2350js `RPUART`) is clocking,
 * published as a SerialLink so the serial monitor can be honest about a mismatch.
 *
 * Both engines expose `onBaudRateChange`, but it fires on the DIVISOR writes (IBRD /
 * FBRD) only, and pico-sdk's uart_init writes the frame format to UARTLCR_H *after*
 * the baud rate — so a link taken at that callback would carry the reset LCR_H (5 data
 * bits, no parity). The write to LCR_H (and to CR, where the port is enabled) is
 * therefore observed too, and the link is re-derived and republished on change only.
 *
 * Which port is the console is the caller's business: arduino-pico's `Serial` is the
 * USB-CDC on a real Pico, but the compile service prepends `#define Serial Serial1` to
 * every rp2040-family sketch, so the sketch's `Serial` IS UART0 here (see
 * RP2350Simulator.serialConsole) and the rate matters exactly as on a wire.
 */
import type { SerialLink } from '../store/serialWire';

/** The slice of rp2040js / rp2350js `RPUART` this reads; both are PL011s. */
export interface RpUartLike {
  onBaudRateChange?: (baudRate: number) => void;
  readonly baudRate: number;
  readUint32(offset: number): number;
  writeUint32(offset: number, value: number): void;
}

/** UARTLCR_H (PL011): WLEN [6:5] = 5 + n data bits, STP2 [3], EPS [2], PEN [1]. */
const UARTLCR_H = 0x2c;
const UARTCR = 0x30;

/** A console with no wire at all: the terminal's rate is discarded, as on real hardware. */
export const USB_CDC_LINK: SerialLink = {
  source: 'usb-cdc',
  baud: 0,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
};

/** Read the line settings off a PL011, or null while it has no usable rate. */
export function rpUartLink(uart: RpUartLike): SerialLink | null {
  const baud = uart.baudRate;
  if (!Number.isFinite(baud) || !(baud > 0)) return null;
  const lcr = uart.readUint32(UARTLCR_H);
  return {
    source: 'uart',
    baud,
    dataBits: 5 + ((lcr >>> 5) & 0x3),
    parity: lcr & 0x2 ? (lcr & 0x4 ? 'even' : 'odd') : 'none',
    stopBits: lcr & 0x8 ? 2 : 1,
  };
}

/**
 * Publish `uart`'s line whenever the guest changes it. Takes over the engine's
 * `onBaudRateChange` slot and wraps `writeUint32` for the format/enable registers;
 * the engine dispatches MMIO through the instance, so the wrapper is what it calls.
 */
export function watchRpUartLine(uart: RpUartLike, onLink: (link: SerialLink) => void): void {
  let last: SerialLink | null = null;
  const publish = (): void => {
    const link = rpUartLink(uart);
    if (!link) return;
    if (
      last &&
      last.baud === link.baud &&
      last.dataBits === link.dataBits &&
      last.parity === link.parity &&
      last.stopBits === link.stopBits
    ) {
      return;
    }
    last = link;
    onLink(link);
  };
  uart.onBaudRateChange = () => publish();
  const write = uart.writeUint32.bind(uart);
  uart.writeUint32 = (offset: number, value: number): void => {
    write(offset, value);
    if (offset === UARTLCR_H || offset === UARTCR) publish();
  };
}
