import serial, time, binascii

PORT = "COM3"     # ← 改成你的 COM
BAUD = 115200     # ← 改成你的波特率

def sum_chk(bs): return sum(bs) & 0xFF
def xor_chk(bs):
    x=0
    for b in bs: x ^= b
    return x & 0xFF

def build_frame(addr, cmd, data, use_sum=True):
    length = len(data)
    core = bytes([addr, cmd, (length>>8)&0xFF, length&0xFF]) + data
    chk  = sum_chk(core) if use_sum else xor_chk(core)
    return b'\xBB' + core + bytes([chk]) + b'\x7E'

def parse_basic(resp: bytes):
    if not resp or len(resp)<7 or resp[0]!=0xBB or resp[-1]!=0x7E:
        return None
    addr = resp[1]; cmd = resp[2]
    length = (resp[3]<<8) + resp[4]
    data = resp[5:5+length]
    return {"addr": addr, "cmd": cmd, "len": length, "data": data}

def send(ser, frame, label):
    print(f"\n→ {label} 送出: {binascii.hexlify(frame).decode()}")
    ser.reset_input_buffer()
    ser.write(frame)
    time.sleep(0.8)  # 多等一點
    resp = ser.read_all()
    print(f"← 回覆: {binascii.hexlify(resp).decode() or '(無回覆)'}")
    return resp

def main():
    with serial.Serial(PORT, BAUD, timeout=0.1) as ser:
        targets = [
            ("addr=0x01 SUM", 0x01, True),
            ("addr=0x01 XOR", 0x01, False),
            ("addr=0x00 SUM", 0x00, True),
            ("addr=0x00 XOR", 0x00, False),
        ]
        # 26.00 dBm → 0x0A28（/100）
        dbm100 = 26*100
        set_data_2B = bytes([(dbm100>>8)&0xFF, dbm100 & 0xFF])

        for label, addr, use_sum in targets:
            # 先 GET
            f_get = build_frame(addr, 0xB7, b"", use_sum)
            r = send(ser, f_get, f"[{label}] GetPower")
            info = parse_basic(r)
            if info and info["cmd"]==0xB7:
                if len(info["data"])==2:
                    val = (info["data"][0]<<8) + info["data"][1]
                    print(f"  解析：可能功率 = {val/100:.2f} dBm")
                else:
                    print(f"  解析：data={binascii.hexlify(info['data']).decode()}")

            # 再 SET（2位元組版本）
            f_set = build_frame(addr, 0xB6, set_data_2B, use_sum)
            r = send(ser, f_set, f"[{label}] SetPower 26.00 dBm (2B)")
            info = parse_basic(r)
            if info and info["cmd"]==0xB6:
                if len(info["data"])>=1 and info["data"][0]==0x00:
                    print("  ✅ 設定成功")
                else:
                    print(f"  ⚠ 非成功碼 data={binascii.hexlify(info['data']).decode() if info else ''}")

            # 再 GET 確認
            r = send(ser, f_get, f"[{label}] GetPower after set")
            info = parse_basic(r)
            if info and info["cmd"]==0xB7 and len(info["data"])==2:
                val = (info["data"][0]<<8) + info["data"][1]
                print(f"  確認：{val/100:.2f} dBm")

if __name__ == "__main__":
    main()
