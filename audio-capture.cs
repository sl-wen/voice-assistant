/**
 * PC Audio Capture Tool v5.0
 * WASAPI Loopback capture - captures system audio
 * Outputs raw PCM 48kHz 16-bit mono to stdout
 * 
 * Fixed: vtable slots, WAVEFORMATEXTENSIBLE detection, float32 support
 */

using System;
using System.Runtime.InteropServices;
using System.Threading;

class LoopbackCapture
{
    [DllImport("ole32.dll")]
    static extern int CoInitialize(IntPtr pvReserved);

    [DllImport("ole32.dll")]
    static extern void CoUninitialize();

    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(
        [In] ref Guid clsid, [In] IntPtr pUnkOuter, [In] uint dwClsCtx,
        [In] ref Guid riid, [Out] out IntPtr ppv);

    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid IID_IMMDeviceEnumerator = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    // IMMDeviceEnumerator: slot 4 = GetDefaultEndpoint
    const int VT_GetDefaultEndpoint = 4;
    // IMMDevice: slot 3 = Activate
    const int VT_Activate = 3;
    // IAudioClient vtable (Windows 10/11):
    //   3=Initialize, 4=GetBufferSize, 5=GetStreamLatency, 6=GetCurrentPadding,
    //   7=IsFormatSupported, 8=GetMixFormat, 9=GetDevicePeriod, 10=Start,
    //   11=Stop, 12=Reset, 13=??(new), 14=GetService
    const int VT_Initialize = 3;
    const int VT_GetMixFormat = 8;
    const int VT_Start = 10;
    const int VT_GetService = 14;
    // IAudioCaptureClient: slot 3=GetBuffer, 4=ReleaseBuffer, 5=GetNextPacketSize
    const int VT_GetBuffer = 3;
    const int VT_ReleaseBuffer = 4;
    const int VT_GetNextPacketSize = 5;

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetDefaultEndpoint(IntPtr self, int dataFlow, int role, out IntPtr device);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelActivate(IntPtr self, ref Guid iid, int clsCtx, IntPtr p, out IntPtr result);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetMixFormat(IntPtr self, out IntPtr ppFormat);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelInitialize(IntPtr self, int shareMode, int streamFlags,
        long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr pSessionGuid);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelStart(IntPtr self);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetService(IntPtr self, IntPtr iidPtr, out IntPtr result);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetNextPacketSize(IntPtr self, out uint frames);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetBuffer(IntPtr self, out IntPtr data, out uint frames,
        out int flags, out ulong pos, out ulong qpc);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelReleaseBuffer(IntPtr self, uint frames);

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public short wFormatTag;
        public short nChannels;
        public int nSamplesPerSec;
        public int nAvgBytesPerSec;
        public short nBlockAlign;
        public short wBitsPerSample;
        public short cbSize;
    }

    static unsafe IntPtr VtSlot(IntPtr comObj, int slot)
    {
        IntPtr* obj = (IntPtr*)comObj.ToPointer();
        IntPtr* vt = (IntPtr*)obj[0].ToPointer();
        return vt[slot];
    }

    static void Main()
    {
        CoInitialize(IntPtr.Zero);
        try
        {
            // 1. Create MMDeviceEnumerator
            IntPtr enumPtr;
            Guid clsid = CLSID_MMDeviceEnumerator, iid = IID_IMMDeviceEnumerator;
            int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out enumPtr);
            if (hr != 0) { Console.Error.WriteLine("ERR_ENUM:" + hr); return; }

            // 2. Get default render endpoint (speakers)
            var getDefault = Marshal.GetDelegateForFunctionPointer<DelGetDefaultEndpoint>(VtSlot(enumPtr, VT_GetDefaultEndpoint));
            IntPtr devicePtr;
            hr = getDefault(enumPtr, 0, 0, out devicePtr);
            Marshal.Release(enumPtr);
            if (hr != 0) { Console.Error.WriteLine("ERR_DEVICE:" + hr); return; }

            // 3. Activate IAudioClient
            var activate = Marshal.GetDelegateForFunctionPointer<DelActivate>(VtSlot(devicePtr, VT_Activate));
            IntPtr acPtr;
            Guid iidAC = IID_IAudioClient;
            hr = activate(devicePtr, ref iidAC, 0, IntPtr.Zero, out acPtr);
            Marshal.Release(devicePtr);
            if (hr != 0) { Console.Error.WriteLine("ERR_ACTIVATE:" + hr); return; }

            // 4. Get mix format
            var getMixFmt = Marshal.GetDelegateForFunctionPointer<DelGetMixFormat>(VtSlot(acPtr, VT_GetMixFormat));
            IntPtr mixFmtPtr;
            hr = getMixFmt(acPtr, out mixFmtPtr);
            if (hr != 0) { Console.Error.WriteLine("ERR_MIX:" + hr); return; }

            var fmt = Marshal.PtrToStructure<WAVEFORMATEX>(mixFmtPtr);
            int sampleRate = fmt.nSamplesPerSec;
            int channels = fmt.nChannels;
            int bitsPerSample = fmt.wBitsPerSample;
            int blockAlign = fmt.nBlockAlign;

            // wFormatTag is signed short, treat as unsigned for comparison
            int formatTag = fmt.wFormatTag & 0xFFFF;
            bool isFloat = (formatTag == 3); // WAVE_FORMAT_IEEE_FLOAT
            bool isExtensible = (formatTag == 0xFFFE && fmt.cbSize >= 22);

            if (isExtensible)
            {
                // WAVEFORMATEXTENSIBLE: WAVEFORMATEX(18) + wValidBitsPerSample(2) + dwChannelMask(4) + SubFormat(16)
                Guid subFmt = Marshal.PtrToStructure<Guid>((IntPtr)((long)mixFmtPtr + 24));
                Guid floatGuid = new Guid("00000003-0000-0010-8000-00aa00389b71");
                Guid pcmGuid = new Guid("00000001-0000-0010-8000-00aa00389b71");
                if (subFmt == floatGuid) isFloat = true;
                else if (subFmt == pcmGuid) isFloat = false;
            }

            Console.Error.WriteLine("MIX:" + sampleRate + "Hz " + channels + "ch " + bitsPerSample + "bit " + (isFloat ? "float" : "pcm") + (isExtensible ? " ext" : ""));

            // 5. Initialize with LOOPBACK
            var initClient = Marshal.GetDelegateForFunctionPointer<DelInitialize>(VtSlot(acPtr, VT_Initialize));
            int fmtSize = 18 + fmt.cbSize;
            IntPtr fmtCopy = Marshal.AllocHGlobal(fmtSize);
            byte[] tmp = new byte[fmtSize];
            Marshal.Copy(mixFmtPtr, tmp, 0, fmtSize);
            Marshal.Copy(tmp, 0, fmtCopy, fmtSize);
            hr = initClient(acPtr, 0, 0x00020000, 50000000L, 0, fmtCopy, IntPtr.Zero);
            Marshal.FreeHGlobal(fmtCopy);
            if (hr != 0) { Console.Error.WriteLine("ERR_INIT:" + hr); return; }

            // 6. GetService -> IAudioCaptureClient (slot 14 on Win10/11!)
            var getService = Marshal.GetDelegateForFunctionPointer<DelGetService>(VtSlot(acPtr, VT_GetService));
            IntPtr capPtr;
            Guid iidCap = IID_IAudioCaptureClient;
            IntPtr pIidCap = Marshal.AllocHGlobal(Marshal.SizeOf(iidCap));
            Marshal.StructureToPtr(iidCap, pIidCap, false);
            hr = getService(acPtr, pIidCap, out capPtr);
            Marshal.FreeHGlobal(pIidCap);
            if (hr != 0) { Console.Error.WriteLine("ERR_SERVICE:" + hr); return; }

            // 7. Start capture
            var startCap = Marshal.GetDelegateForFunctionPointer<DelStart>(VtSlot(acPtr, VT_Start));
            hr = startCap(acPtr);
            if (hr != 0) { Console.Error.WriteLine("ERR_START:" + hr); return; }

            Console.Error.WriteLine("CAPTURING");

            // 8. Capture loop
            var getNextPacket = Marshal.GetDelegateForFunctionPointer<DelGetNextPacketSize>(VtSlot(capPtr, VT_GetNextPacketSize));
            var getBuffer = Marshal.GetDelegateForFunctionPointer<DelGetBuffer>(VtSlot(capPtr, VT_GetBuffer));
            var releaseBuffer = Marshal.GetDelegateForFunctionPointer<DelReleaseBuffer>(VtSlot(capPtr, VT_ReleaseBuffer));
            var stdout = Console.OpenStandardOutput();

            while (true)
            {
                uint pktFrames;
                hr = getNextPacket(capPtr, out pktFrames);
                if (hr != 0 || pktFrames == 0) { Thread.Sleep(1); continue; }

                while (pktFrames > 0)
                {
                    IntPtr dataPtr;
                    uint frames;
                    int flags;
                    ulong pos, qpc;

                    hr = getBuffer(capPtr, out dataPtr, out frames, out flags, out pos, out qpc);
                    if (hr != 0) break;

                    if (isFloat && bitsPerSample == 32)
                    {
                        // Float32 multi-channel -> mono int16
                        int total = (int)frames * channels;
                        float[] all = new float[total];
                        Marshal.Copy(dataPtr, all, 0, total);
                        short[] mono = new short[frames];
                        for (int i = 0; i < frames; i++)
                        {
                            float s = all[i * channels];
                            if (s > 1f) s = 1f; else if (s < -1f) s = -1f;
                            mono[i] = (short)(s * 32767f);
                        }
                        byte[] buf = new byte[frames * 2];
                        Buffer.BlockCopy(mono, 0, buf, 0, buf.Length);
                        stdout.Write(buf, 0, buf.Length);
                    }
                    else if (bitsPerSample == 16)
                    {
                        if (channels == 1)
                        {
                            byte[] buf = new byte[(int)frames * blockAlign];
                            Marshal.Copy(dataPtr, buf, 0, buf.Length);
                            stdout.Write(buf, 0, buf.Length);
                        }
                        else
                        {
                            int total = (int)frames * channels;
                            short[] all = new short[total];
                            Marshal.Copy(dataPtr, all, 0, total);
                            short[] mono = new short[frames];
                            for (int i = 0; i < frames; i++) mono[i] = all[i * channels];
                            byte[] buf = new byte[frames * 2];
                            Buffer.BlockCopy(mono, 0, buf, 0, buf.Length);
                            stdout.Write(buf, 0, buf.Length);
                        }
                    }
                    else if (bitsPerSample == 32 && !isFloat)
                    {
                        int total = (int)frames * channels;
                        int[] all = new int[total];
                        Marshal.Copy(dataPtr, all, 0, total);
                        short[] mono = new short[frames];
                        for (int i = 0; i < frames; i++) mono[i] = (short)(all[i * channels] >> 16);
                        byte[] buf = new byte[frames * 2];
                        Buffer.BlockCopy(mono, 0, buf, 0, buf.Length);
                        stdout.Write(buf, 0, buf.Length);
                    }
                    else
                    {
                        Console.Error.WriteLine("UNSUPPORTED:" + bitsPerSample + "bit " + (isFloat ? "float" : "pcm"));
                        break;
                    }

                    releaseBuffer(capPtr, frames);
                    getNextPacket(capPtr, out pktFrames);
                }
                stdout.Flush();
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERR:" + ex.Message);
        }
        finally
        {
            CoUninitialize();
        }
    }
}
