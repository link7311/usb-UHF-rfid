import serial, time, binascii

PORT = "COM3"
BAUD = 115200
CMD_INVENTORY = bytes.fromhex("BB00220000227E")  # 有些模組也接受此簡短包；若無回應，用下面那行：
# CMD_INVENTORY = bytes.fromhex("BB 00 22 00 00 22 7E".replace(" ",""))

def parse_inventory_frame(frame: bytes):
    # 基本格式：BB | addr | cmd | lenH lenL | data... | cksH cksL | 7E
    if len(frame) < 9 or frame[0] != 0xBB or frame[-1] != 0x7E:
        return None
    length = (frame[3] << 8) + frame[4]
    data = frame[5:5+length]

    # 常見資料格式： PC(2) + ANT/RSSI(1) + EPC(N) + CRC(2)
    if len(data) < 5:
        return None

    pc = data[0:2]
    # 依常見模組：第3位元組可能是天線/訊號欄位
    epc_and_crc = data[2:]  # 先跳過 pc(2) 與 可能的天線/訊號(1) → 這裡依不同模組可能要調 1 或 0
    # 嘗試先視為：pc(2) + ant(1) + EPC(?) + CRC(2)
    if len(epc_and_crc) >= 3:
        epc = epc_and_crc[:-2]
        crc = epc_and_crc[-2:]
        return {
            "pc": pc.hex(),
            "epc": epc.hex(),
            "crc": crc.hex()
        }
    return None

def read_frames(ser: serial.Serial, timeout_ms=200):
    """簡單地把一次回應全部抓出來（可能包含 1~多包），以 0xBB..0x7E 切包"""
    time.sleep(timeout_ms/1000)
    raw = ser.read_all()
    frames = []
    if not raw:
        return frames
    # 以頭尾標記切分
    buf = raw
    while True:
        start = buf.find(b'\xBB')
        if start < 0: break
        end = buf.find(b'\x7E', start+1)
        if end < 0: break
        frames.append(buf[start:end+1])
        buf = buf[end+1:]
    return frames

def main():
    ser = serial.Serial(PORT, BAUD, timeout=0.05)
    print(f"開啟 {PORT} @ {BAUD}，開始連續掃描（Ctrl+C 停止）...")
    try:
        while True:
            ser.write(CMD_INVENTORY)
            frames = read_frames(ser, timeout_ms=300)
            for fr in frames:
                info = parse_inventory_frame(fr)
                if info and info["epc"]:
                    print("EPC:", info["epc"].upper())
                else:
                    # 除錯用：印原始回應
                    # print("RAW:", binascii.hexlify(fr).decode())
                    pass
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()
        print("已關閉連線")

if __name__ == "__main__":
    main()
