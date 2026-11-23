/**
 * 测试专用：最小化的 store-only ZIP 读取器。
 * 只解析本项目 zip.js 会生成的结构（method 0、无 data descriptor、无 ZIP64），
 * 用于在 Node 侧逐字节校验导出结果（不参与扩展运行时）。
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const decoder = new TextDecoder('utf-8');

function assertSignature(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}：期望 0x${expected.toString(16)}，实际 0x${actual.toString(16)}`);
    }
}

/**
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{entries: Array<{name:string,flags:number,method:number,time:number,date:number,crc:number,size:number,data:Uint8Array}>,
 *            count:number, cdSize:number, cdOffset:number, names:string[], byName:Map<string, any>}}
 */
export function unzip(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    let eocdOffset = -1;
    const minOffset = Math.max(0, data.length - 22 - 65535);
    for (let i = data.length - 22; i >= minOffset; i -= 1) {
        if (view.getUint32(i, true) === EOCD_SIGNATURE) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset < 0) {
        throw new Error('未找到 EOCD 签名');
    }

    const count = view.getUint16(eocdOffset + 10, true);
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    if (cdOffset + cdSize !== eocdOffset) {
        throw new Error(`中央目录偏移与 EOCD 不连续：${cdOffset}+${cdSize} != ${eocdOffset}`);
    }

    const entries = [];
    let pointer = cdOffset;
    for (let i = 0; i < count; i += 1) {
        assertSignature(view.getUint32(pointer, true), CENTRAL_SIGNATURE, '中央目录条目签名错误');
        const flags = view.getUint16(pointer + 8, true);
        const method = view.getUint16(pointer + 10, true);
        const time = view.getUint16(pointer + 12, true);
        const date = view.getUint16(pointer + 14, true);
        const crc = view.getUint32(pointer + 16, true);
        const compressedSize = view.getUint32(pointer + 20, true);
        const size = view.getUint32(pointer + 24, true);
        const nameLength = view.getUint16(pointer + 28, true);
        const extraLength = view.getUint16(pointer + 30, true);
        const commentLength = view.getUint16(pointer + 32, true);
        const localOffset = view.getUint32(pointer + 42, true);
        const name = decoder.decode(data.subarray(pointer + 46, pointer + 46 + nameLength));

        assertSignature(view.getUint32(localOffset, true), LOCAL_SIGNATURE, `local header 签名错误（${name}）`);
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const content = data.slice(dataStart, dataStart + size);

        entries.push({
            name,
            flags,
            method,
            time,
            date,
            crc,
            compressedSize,
            size,
            localOffset,
            data: content,
        });
        pointer += 46 + nameLength + extraLength + commentLength;
    }

    return {
        entries,
        count,
        cdSize,
        cdOffset,
        names: entries.map((entry) => entry.name),
        byName: new Map(entries.map((entry) => [entry.name, entry])),
    };
}

/** 以 UTF-8 解码某个条目的内容。 */
export function textOf(entry) {
    return decoder.decode(entry.data);
}
