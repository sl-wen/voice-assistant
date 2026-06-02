// AudioBridge.cs - Tiny Windows audio bridge tool
// Compile: csc /out:AudioBridge.exe /target:winexe AudioBridge.cs
// 
// Usage:
//   AudioBridge.exe play        - Read PCM from stdin, play to default speaker
//   AudioBridge.exe record      - Record from default mic, write PCM to stdout
//   AudioBridge.exe list        - List audio devices
//
// PCM format: 48kHz, 16bit, mono (matches web audio)

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Generic;

namespace AudioBridge
{
    class Program
    {
        // WinMM API
        [DllImport("winmm.dll")]
        static extern int waveOutOpen(out IntPtr hWaveOut, int uDeviceID, ref WAVEFORMATEX lpFormat, IntPtr dwCallback, IntPtr dwInstance, int dwFlags);

        [DllImport("winmm.dll")]
        static extern int waveOutPrepareHeader(IntPtr hWaveOut, ref WAVEHDR lpWaveOutHdr, int cbWaveOutHdr);

        [DllImport("winmm.dll")]
        static extern int waveOutWrite(IntPtr hWaveOut, ref WAVEHDR lpWaveOutHdr, int cbWaveOutHdr);

        [DllImport("winmm.dll")]
        static extern int waveOutUnprepareHeader(IntPtr hWaveOut, ref WAVEHDR lpWaveOutHdr, int cbWaveOutHdr);

        [DllImport("winmm.dll")]
        static extern int waveOutClose(IntPtr hWaveOut);

        [DllImport("winmm.dll")]
        static extern int waveInOpen(out IntPtr hWaveIn, int uDeviceID, ref WAVEFORMATEX lpFormat, IntPtr dwCallback, IntPtr dwInstance, int dwFlags);

        [DllImport("winmm.dll")]
        static extern int waveInPrepareHeader(IntPtr hWaveIn, ref WAVEHDR lpWaveInHdr, int cbWaveInHdr);

        [DllImport("winmm.dll")]
        static extern int waveInAddBuffer(IntPtr hWaveIn, ref WAVEHDR lpWaveInHdr, int cbWaveInHdr);

        [DllImport("winmm.dll")]
        static extern int waveInStart(IntPtr hWaveIn);

        [DllImport("winmm.dll")]
        static extern int waveInStop(IntPtr hWaveIn);

        [DllImport("winmm.dll")]
        static extern int waveInUnprepareHeader(IntPtr hWaveIn, ref WAVEHDR lpWaveInHdr, int cbWaveInHdr);

        [DllImport("winmm.dll")]
        static extern int waveInClose(IntPtr hWaveIn);

        [DllImport("winmm.dll")]
        static extern int waveOutGetNumDevs();

        [DllImport("winmm.dll")]
        static extern int waveInGetNumDevs();

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

        [StructLayout(LayoutKind.Sequential)]
        struct WAVEHDR
        {
            public IntPtr lpData;
            public int dwBufferLength;
            public int dwBytesRecorded;
            public IntPtr dwUser;
            public int dwFlags;
            public int dwLoops;
            public IntPtr lpNext;
            public IntPtr reserved;
        }

        const int WAVE_FORMAT_PCM = 1;
        const int BUFFER_SIZE = 9600; // 100ms at 48kHz 16bit mono

        static void Main(string[] args)
        {
            if (args.Length == 0)
            {
                Console.WriteLine("Usage: AudioBridge.exe [play|record|list]");
                return;
            }

            switch (args[0].ToLower())
            {
                case "play":
                    PlayAudio();
                    break;
                case "record":
                    RecordAudio();
                    break;
                case "list":
                    ListDevices();
                    break;
                default:
                    Console.WriteLine("Unknown command: " + args[0]);
                    break;
            }
        }

        static void ListDevices()
        {
            Console.WriteLine("Output devices: " + waveOutGetNumDevs());
            Console.WriteLine("Input devices: " + waveInGetNumDevs());
        }

        static WAVEFORMATEX CreateFormat()
        {
            return new WAVEFORMATEX
            {
                wFormatTag = WAVE_FORMAT_PCM,
                nChannels = 1,
                nSamplesPerSec = 48000,
                nAvgBytesPerSec = 48000 * 2,
                nBlockAlign = 2,
                wBitsPerSample = 16,
                cbSize = 0
            };
        }

        static void PlayAudio()
        {
            var format = CreateFormat();
            IntPtr hWaveOut;
            int result = waveOutOpen(out hWaveOut, -1, ref format, IntPtr.Zero, IntPtr.Zero, 0);
            if (result != 0)
            {
                Console.Error.WriteLine("Failed to open audio output: " + result);
                Environment.Exit(1);
            }

            var stream = Console.OpenStandardInput();
            byte[] buffer = new byte[BUFFER_SIZE];

            while (true)
            {
                int read = stream.Read(buffer, 0, BUFFER_SIZE);
                if (read <= 0) break;

                var audioData = Marshal.AllocHGlobal(read);
                Marshal.Copy(buffer, 0, audioData, read);

                WAVEHDR hdr = new WAVEHDR();
                hdr.lpData = audioData;
                hdr.dwBufferLength = read;

                waveOutPrepareHeader(hWaveOut, ref hdr, Marshal.SizeOf(hdr));
                waveOutWrite(hWaveOut, ref hdr, Marshal.SizeOf(hdr));

                // Wait for playback
                while ((hdr.dwFlags & 1) == 0) // WHDR_DONE = 1
                {
                    Thread.Sleep(1);
                }

                waveOutUnprepareHeader(hWaveOut, ref hdr, Marshal.SizeOf(hdr));
                Marshal.FreeHGlobal(audioData);
            }

            waveOutClose(hWaveOut);
        }

        static void RecordAudio()
        {
            var format = CreateFormat();
            IntPtr hWaveIn;
            int result = waveInOpen(out hWaveIn, -1, ref format, IntPtr.Zero, IntPtr.Zero, 0);
            if (result != 0)
            {
                Console.Error.WriteLine("Failed to open audio input: " + result);
                Environment.Exit(1);
            }

            var outputStream = Console.OpenStandardOutput();
            bool recording = true;

            Console.CancelKeyPress += (s, e) => {
                e.Cancel = true;
                recording = false;
            };

            // Use multiple buffers for smooth recording
            for (int i = 0; i < 3; i++)
            {
                var buf = Marshal.AllocHGlobal(BUFFER_SIZE);
                WAVEHDR hdr = new WAVEHDR();
                hdr.lpData = buf;
                hdr.dwBufferLength = BUFFER_SIZE;

                waveInPrepareHeader(hWaveIn, ref hdr, Marshal.SizeOf(hdr));
                waveInAddBuffer(hWaveIn, ref hdr, Marshal.SizeOf(hdr));
            }

            waveInStart(hWaveIn);

            while (recording)
            {
                Thread.Sleep(10);
            }

            waveInStop(hWaveIn);
            waveInClose(hWaveIn);
        }
    }
}
