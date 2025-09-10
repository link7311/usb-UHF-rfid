import serial, time, binascii

PORT = "COM5"
BAUD = 115200
CMD_INVENTORY = bytes.fromhex("BB00220000227E")  # 若無回應，改成：bytes.fromhex("BB00220000227E")

def cut_frames(raw: bytes):
    frames = []
    buf = raw
    while True:
        s = buf.find(b'\xBB')
        if s < 0: break
        e = buf.find(b'\x7E', s+1)
        if e < 0: break
        frames.append(buf[s:e+1])
        buf = buf[e+1:]
    return frames

def parse_frame(fr: bytes):
    # BB | addr | cmd | lenH lenL | data... | chkH chkL | 7E
    if len(fr) < 9 or fr[0] != 0xBB or fr[-1] != 0x7E:
        return None
    length = (fr[3] << 8) + fr[4]
    data = fr[5:5+length]
    if len(data) < 5:
        return None
    pc = data[0:2]
    rest = data[2:]

    # 嘗試「有/無 1 個 byte 的天線/RSSI 欄位」
    for skip in (1, 0):
        if len(rest) - skip >= 3:
            epc = rest[skip:-2]
            crc = rest[-2:]
            if len(epc) >= 4:
                return {"pc": pc.hex(), "epc": epc.hex().upper(), "crc": crc.hex()}
    return None

def inventory_round(ser: serial.Serial, window_ms=400):
    """發一次指令，於 window_ms 內收集該輪所有 EPC（去重後回傳 set）。"""
    ser.reset_input_buffer()
    ser.write(CMD_INVENTORY)
    end_t = time.time() + window_ms/1000
    raw = b""
    while time.time() < end_t:
        time.sleep(0.03)
        raw += ser.read_all()
    epcs = set()
    for fr in cut_frames(raw):
        info = parse_frame(fr)
        if info and info["epc"]:
            epcs.add(info["epc"])
    return epcs

def main():
    ser = serial.Serial(PORT, BAUD, timeout=0.05)
    print(f"開始多標籤測試（Ctrl+C 結束） on {PORT}@{BAUD}")
    try:
        round_id = 1
        while True:
            epcs = inventory_round(ser, window_ms=400)
            if epcs:
                print(f"[Round {round_id}] 共 {len(epcs)} 張：", ", ".join(sorted(epcs)))
            else:
                print(f"[Round {round_id}] 未偵測到標籤")
            round_id += 1
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()
        print("已關閉連線")

if __name__ == "__main__":
    main()
