import serial, time, binascii

PORT = "COM3"
BAUD = 115200

def sum_chk(bs): return sum(bs) & 0xFF

def build_frame(cmd, data=b"", addr=0x00):
    length = len(data)
    core = bytes([addr, cmd, (length>>8)&0xFF, length&0xFF]) + data
    chk  = sum_chk(core)
    return b'\xBB' + core + bytes([chk]) + b'\x7E'

def parse(resp: bytes):
    if not (resp and resp[0]==0xBB and resp[-1]==0x7E and len(resp)>=7):
        return None
    addr = resp[1]; cmd = resp[2]
    length = (resp[3]<<8) + resp[4]
    data = resp[5:5+length]
    return {"addr": addr, "cmd": cmd, "len": length, "data": data, "raw": resp}

def get_power(ser):
    ser.reset_input_buffer()
    ser.write(build_frame(0xB7))
    time.sleep(0.2)
    r = ser.read_all()
    info = parse(r)
    if info and info["cmd"] == 0xB7 and info["len"] == 2:
        val = (info["data"][0]<<8) + info["data"][1]  # /100 dBm
        return val / 100.0
    raise RuntimeError(f"GetPower 失敗，回覆={binascii.hexlify(r).decode()}")

def set_power(ser, dbm: float):
    val = int(round(dbm * 100))
    data = bytes([(val>>8)&0xFF, val & 0xFF])
    ser.reset_input_buffer()
    ser.write(build_frame(0xB6, data))
    time.sleep(0.2)
    r = ser.read_all()
    info = parse(r)
    if info and info["cmd"] == 0xB6 and info["len"] >= 1 and info["data"][0] == 0x00:
        return True
    raise RuntimeError(f"SetPower 失敗，回覆={binascii.hexlify(r).decode()}")

if __name__ == "__main__":
    with serial.Serial(PORT, BAUD, timeout=0.2) as ser:
        # 設為 26 dBm
        ok = set_power(ser, 26.00)
        print("SetPower:", "成功" if ok else "失敗")

        # 驗證
        p = get_power(ser)
        print(f"當前功率：{p:.2f} dBm")
