Add-Type -AssemblyName System.Drawing

function New-TeleprompterIcon {
  param([int]$Size, [string]$Path, [bool]$Maskable = $false)
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::FromArgb(255, 7, 11, 20))

  $pad = if ($Maskable) { [int]($Size * 0.10) } else { [int]($Size * 0.02) }
  $rect = New-Object System.Drawing.Rectangle($pad, $pad, ($Size - 2*$pad), ($Size - 2*$pad))
  $radius = if ($Maskable) { [int]($Size * 0.20) } else { [int]($Size * 0.22) }
  $pathObj = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $pathObj.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $pathObj.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $pathObj.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $pathObj.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $pathObj.CloseFigure()

  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 13, 23, 42), [System.Drawing.Color]::FromArgb(255, 7, 11, 20), 45)
  $g.FillPath($bgBrush, $pathObj)

  $glowBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(90, 34, 211, 238), [System.Drawing.Color]::FromArgb(55, 192, 132, 252), 45)
  $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gx = [int]($Size * 0.16); $gy = [int]($Size * 0.13); $gw = [int]($Size * 0.68); $gh = [int]($Size * 0.74)
  $gr = [int]($Size * 0.13); $gd = $gr * 2
  $glowPath.AddArc($gx, $gy, $gd, $gd, 180, 90)
  $glowPath.AddArc($gx + $gw - $gd, $gy, $gd, $gd, 270, 90)
  $glowPath.AddArc($gx + $gw - $gd, $gy + $gh - $gd, $gd, $gd, 0, 90)
  $glowPath.AddArc($gx, $gy + $gh - $gd, $gd, $gd, 90, 90)
  $glowPath.CloseFigure()
  $g.FillPath($glowBrush, $glowPath)

  # Lightning bolt
  $bolt = @(
    [System.Drawing.PointF]::new([float]($Size * 0.60), [float]($Size * 0.16)),
    [System.Drawing.PointF]::new([float]($Size * 0.36), [float]($Size * 0.54)),
    [System.Drawing.PointF]::new([float]($Size * 0.52), [float]($Size * 0.54)),
    [System.Drawing.PointF]::new([float]($Size * 0.42), [float]($Size * 0.84)),
    [System.Drawing.PointF]::new([float]($Size * 0.70), [float]($Size * 0.44)),
    [System.Drawing.PointF]::new([float]($Size * 0.54), [float]($Size * 0.44))
  )
  $boltBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 34, 211, 238), [System.Drawing.Color]::FromArgb(255, 168, 85, 247), 35)
  $g.FillPolygon($boltBrush, $bolt)

  $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(210, 226, 232, 240))
  $lw = [int]($Size * 0.44); $lh = [float]($Size * 0.035); $lx = [float]($Size * 0.16); $ly = [float]($Size * 0.76)
  $g.FillRectangle($lineBrush, $lx, $ly, $lw, $lh)
  $lineBrush2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(120, 226, 232, 240))
  $g.FillRectangle($lineBrush2, $lx, ($ly + $Size * 0.07), ($lw * 0.62), $lh)

  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output $Path
}

New-TeleprompterIcon -Size 192 -Path "D:\Development\advanced-teleprompter\public\icons\icon-192.png"
New-TeleprompterIcon -Size 512 -Path "D:\Development\advanced-teleprompter\public\icons\icon-512.png"
New-TeleprompterIcon -Size 512 -Path "D:\Development\advanced-teleprompter\public\icons\icon-maskable-512.png" -Maskable $true
New-TeleprompterIcon -Size 180 -Path "D:\Development\advanced-teleprompter\public\icons\apple-touch-icon.png"
