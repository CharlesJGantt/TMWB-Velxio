import { describe, expect, it } from 'vitest';
import { RP2040 } from 'rp2040js';
import { rpUartLink, watchRpUartLine } from '../simulation/rpUartLine';
import type { SerialLink } from '../store/serialWire';

/**
 * The line a Pico's PL011 clocks, read back off the engine the way pico-sdk writes it:
 * uart_set_baudrate -> IBRD/FBRD, then uart_set_format -> LCR_H, then CR. A link taken
 * at the engine's onBaudRateChange alone would carry the reset LCR_H (5 data bits).
 */
const UARTIBRD = 0x24;
const UARTFBRD = 0x28;
const UARTLCR_H = 0x2c;
const UARTCR = 0x30;
const CLK_PERI = 125_000_000;

/** pico-sdk uart_set_baudrate + uart_set_format(8N1), byte for byte. */
function guestInit(uart: RP2040['uart'][0], baud: number, lcr = 0x70 /* WLEN=8, FEN */): void {
  const div = Math.floor((8 * CLK_PERI) / baud);
  let ibrd = div >>> 7;
  let fbrd: number;
  if (ibrd === 0) {
    ibrd = 1;
    fbrd = 0;
  } else if (ibrd >= 65535) {
    ibrd = 65535;
    fbrd = 0;
  } else {
    fbrd = ((div & 0x7f) + 1) >>> 1;
  }
  uart.writeUint32(UARTIBRD, ibrd);
  uart.writeUint32(UARTFBRD, fbrd);
  uart.writeUint32(UARTLCR_H, lcr);
  uart.writeUint32(UARTCR, 0x301); // UARTEN | TXE | RXE
}

describe('the line a Pico UART clocks', () => {
  it('decodes the standard rates within the divider error', () => {
    for (const baud of [300, 1200, 9600, 19200, 38400, 57600, 115200, 230400, 921600]) {
      const mcu = new RP2040();
      guestInit(mcu.uart[0], baud);
      const link = rpUartLink(mcu.uart[0]);
      expect(link, `${baud}`).not.toBeNull();
      expect(Math.abs(link!.baud - baud) / baud, `${baud} -> ${link!.baud}`).toBeLessThan(0.005);
      expect(link).toMatchObject({ source: 'uart', dataBits: 8, parity: 'none', stopBits: 1 });
    }
  });

  it('reports the FORMAT the guest wrote after the rate, not the reset one', () => {
    const mcu = new RP2040();
    const seen: SerialLink[] = [];
    watchRpUartLine(mcu.uart[0], (l) => seen.push(l));
    guestInit(mcu.uart[0], 9600, (2 << 5) | 0x8 | 0x4 | 0x2); // 7E2
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toMatchObject({ dataBits: 7, parity: 'even', stopBits: 2 });
    expect(Math.abs(seen[seen.length - 1].baud - 9600) / 9600).toBeLessThan(0.005);
  });

  it('publishes on change only', () => {
    const mcu = new RP2040();
    const seen: SerialLink[] = [];
    watchRpUartLine(mcu.uart[0], (l) => seen.push(l));
    guestInit(mcu.uart[0], 115200);
    const n = seen.length;
    guestInit(mcu.uart[0], 115200); // the driver re-applying its config says nothing new
    expect(seen.length).toBe(n);
    guestInit(mcu.uart[0], 9600);
    expect(seen.length).toBeGreaterThan(n);
  });

  it('has no rate to report before the divisor is programmed', () => {
    expect(rpUartLink(new RP2040().uart[0])).toBeNull();
  });
});
