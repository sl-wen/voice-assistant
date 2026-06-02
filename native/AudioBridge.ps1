# AudioBridge - Windows audio bridge via PowerShell + .NET
# Called by Node.js server for zero-dependency audio I/O
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File AudioBridge.ps1 -Mode Play
#   powershell -ExecutionPolicy Bypass -File AudioBridge.ps1 -Mode Record
#   powershell -ExecutionPolicy Bypass -File AudioBridge.ps1 -Mode ListDevices

param(
    [ValidateSet("Play", "Record", "ListDevices")]
    [string]$Mode = "ListDevices"
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WaveAudio {
    // WaveOut
    [DllImport("winmm.dll", SetLastError=true)]
    public static extern int waveOutOpen(out IntPtr hwo, int uDeviceID, ref WaveFormat pwfx, IntPtr dwCallback, IntPtr dwInstance, int fdwOpen);
    
    [DllImport("winmm.dll")]
    public static extern int waveOutPrepareHeader(IntPtr hwo, IntPtr pwh, int cbwh);
    
    [DllImport("winmm.dll")]
    public static extern int waveOutWrite(IntPtr hwo, IntPtr pwh, int cbwh);
    
    [DllImport("winmm.dll")]
    public static extern int waveOutUnprepareHeader(IntPtr hwo, IntPtr pwh, int cbwh);
    
    [DllImport("winmm.dll")]
    public static extern int waveOutClose(IntPtr hwo);
    
    [DllImport("winmm.dll")]
    public static extern int waveOutGetNumDevs();
    
    // WaveIn
    [DllImport("winmm.dll", SetLastError=true)]
    public static extern int waveInOpen(out IntPtr hwi, int uDeviceID, ref WaveFormat pwfx, IntPtr dwCallback, IntPtr dwInstance, int fdwOpen);
    
    [DllImport("winmm.dll")]
    public static extern int waveInPrepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);
    
    [DllImport("winmm.dll")]
    public static extern int waveInAddBuffer(IntPtr hwi, IntPtr pwh, int cbwh);
    
    [DllImport("winmm.dll")]
    public static extern int waveInStart(IntPtr hwi);
    
    [DllImport("winmm.dll")]
    public static extern int waveInStop(IntPtr hwi);
    
    [DllImport("winmm.dll")]
    public static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);
    
    [DllImport("winmm.dll")]
    public static extern int waveInClose(IntPtr hwi);
    
    [DllImport("winmm.dll")]
    public static extern int waveInGetNumDevs();
    
    [StructLayout(LayoutKind.Sequential)]
    public struct WaveFormat {
        public short wFormatTag;
        public short nChannels;
        public int nSamplesPerSec;
        public int nAvgBytesPerSec;
        public short nBlockAlign;
        public short wBitsPerSample;
        public short cbSize;
    }
    
    [StructLayout(LayoutKind.Sequential)]
    public struct WaveHeader {
        public IntPtr lpData;
        public int dwBufferLength;
        public int dwBytesRecorded;
        public IntPtr dwUser;
        public int dwFlags;
        public int dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }
    
    public static WaveFormat CreatePCMFormat(int sampleRate, int channels, int bitsPerSample) {
        var fmt = new WaveFormat();
        fmt.wFormatTag = 1; // PCM
        fmt.nChannels = (short)channels;
        fmt.nSamplesPerSec = sampleRate;
        fmt.wBitsPerSample = (short)bitsPerSample;
        fmt.nBlockAlign = (short)(channels * bitsPerSample / 8);
        fmt.nAvgBytesPerSec = sampleRate * fmt.nBlockAlign;
        fmt.cbSize = 0;
        return fmt;
    }
}
"@

$ErrorActionPreference = "Stop"

switch ($Mode) {
    "ListDevices" {
        $outDevs = [WaveAudio]::waveOutGetNumDevs()
        $inDevs = [WaveAudio]::waveInGetNumDevs()
        Write-Output "OUTPUT_DEVICES=$outDevs"
        Write-Output "INPUT_DEVICES=$inDevs"
    }
    
    "Play" {
        # Read PCM from stdin, play to default output device
        $fmt = [WaveAudio]::CreatePCMFormat(48000, 1, 16)
        [IntPtr]$hWaveOut = [IntPtr]::Zero
        $result = [WaveAudio]::waveOutOpen([ref]$hWaveOut, -1, [ref]$fmt, [IntPtr]::Zero, [IntPtr]::Zero, 0)
        
        if ($result -ne 0) {
            Write-Error "waveOutOpen failed: $result"
            exit 1
        }
        
        $bufferSize = 9600  # 100ms at 48kHz 16bit mono
        $buffer = New-Object byte[] $bufferSize
        $stream = [Console]::OpenStandardInput()
        
        while ($true) {
            $read = $stream.Read($buffer, 0, $bufferSize)
            if ($read -le 0) { break }
            
            $audioPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($read)
            [System.Runtime.InteropServices.Marshal]::Copy($buffer, 0, $audioPtr, $read)
            
            $hdr = New-Object WaveAudio+WaveHeader
            $hdr.lpData = $audioPtr
            $hdr.dwBufferLength = $read
            
            $hdrPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([System.Runtime.InteropServices.Marshal]::SizeOf($hdr))
            [System.Runtime.InteropServices.Marshal]::StructureToPtr($hdr, $hdrPtr, $false)
            
            [WaveAudio]::waveOutPrepareHeader($hWaveOut, $hdrPtr, [System.Runtime.InteropServices.Marshal]::SizeOf($hdr)) | Out-Null
            [WaveAudio]::waveOutWrite($hWaveOut, $hdrPtr, [System.Runtime.InteropServices.Marshal]::SizeOf($hdr)) | Out-Null
            
            # Wait for done
            $iterations = 0
            do {
                Start-Sleep -Milliseconds 1
                $hdr = [System.Runtime.InteropServices.Marshal]::PtrToStructure($hdrPtr, [type][WaveAudio+WaveHeader])
                $iterations++
            } while (($hdr.dwFlags -band 1) -eq 0 -and $iterations -lt 1000)
            
            [WaveAudio]::waveOutUnprepareHeader($hWaveOut, $hdrPtr, [System.Runtime.InteropServices.Marshal]::SizeOf($hdr)) | Out-Null
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($audioPtr)
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($hdrPtr)
        }
        
        [WaveAudio]::waveOutClose($hWaveOut) | Out-Null
    }
    
    "Record" {
        # Record from default input, write PCM to stdout
        $fmt = [WaveAudio]::CreatePCMFormat(48000, 1, 16)
        [IntPtr]$hWaveIn = [IntPtr]::Zero
        $result = [WaveAudio]::waveInOpen([ref]$hWaveIn, -1, [ref]$fmt, [IntPtr]::Zero, [IntPtr]::Zero, 0)
        
        if ($result -ne 0) {
            Write-Error "waveInOpen failed: $result"
            exit 1
        }
        
        # TODO: Implement recording with callbacks
        # For now, just signal that recording is available
        Write-Output "RECORDING_READY"
    }
}
