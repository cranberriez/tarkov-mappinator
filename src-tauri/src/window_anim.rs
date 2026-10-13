use serde::Deserialize;
use std::time::{Duration, Instant};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

/// Target outer position and inner size, in physical pixels.
#[derive(Deserialize)]
pub struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

const FRAME: Duration = Duration::from_millis(8);

fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

fn lerp(from: f64, to: f64, t: f64) -> f64 {
    from + (to - from) * t
}

/// Moves and resizes the window to `to` over `duration_ms`, frame by frame on this worker thread.
#[tauri::command(async)]
pub fn animate_window(window: WebviewWindow, to: Bounds, duration_ms: u64) -> Result<(), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let duration = Duration::from_millis(duration_ms);
    let start = Instant::now();
    loop {
        let t = if duration.is_zero() {
            1.0
        } else {
            (start.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0)
        };
        let k = ease_out_cubic(t);
        let x = lerp(position.x as f64, to.x as f64, k).round() as i32;
        let y = lerp(position.y as f64, to.y as f64, k).round() as i32;
        let width = lerp(size.width as f64, to.width as f64, k).round() as u32;
        let height = lerp(size.height as f64, to.height as f64, k).round() as u32;
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        window
            .set_size(PhysicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        if t >= 1.0 {
            return Ok(());
        }
        std::thread::sleep(FRAME);
    }
}

/// A window's restore rectangle, in Windows workspace coordinates; only ever handed back unchanged.
#[derive(serde::Serialize, Deserialize, Clone, Copy)]
pub struct Restore {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

/// Leaves the maximized state without moving or animating the window, so a resize can start from where it
/// is. Returns the rectangle Windows would have restored to, or `None` if the window wasn't maximized.
#[tauri::command]
pub fn unmaximize_in_place(window: WebviewWindow) -> Result<Option<Restore>, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        Ok(win32::unmaximize_in_place(hwnd))
    }
    #[cfg(not(windows))]
    {
        let maximized = window.is_maximized().map_err(|e| e.to_string())?;
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(maximized.then_some(Restore {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        }))
    }
}

/// Maximizes in one step with `restore` as the size to un-maximize to, avoiding a flash of the restored size.
#[tauri::command]
pub fn maximize_with_restore(window: WebviewWindow, restore: Restore) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        win32::maximize_with_restore(hwnd, restore);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = restore;
        window.maximize().map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
mod win32 {
    use super::Restore;
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        ClientToScreen, GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowPlacement, GetWindowRect, IsZoomed, SetWindowPlacement,
        SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE, SW_SHOWMAXIMIZED,
        SW_SHOWNORMAL, WINDOWPLACEMENT,
    };

    fn placement(hwnd: *mut c_void) -> WINDOWPLACEMENT {
        let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
        placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
        unsafe { GetWindowPlacement(hwnd, &mut placement) };
        placement
    }

    fn window_rect(hwnd: *mut c_void) -> RECT {
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        unsafe { GetWindowRect(hwnd, &mut rect) };
        rect
    }

    /// The visible client area in screen coordinates.
    fn client_rect(hwnd: *mut c_void) -> RECT {
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        let mut origin = POINT { x: 0, y: 0 };
        unsafe {
            GetClientRect(hwnd, &mut rect);
            ClientToScreen(hwnd, &mut origin);
        }
        RECT {
            left: origin.x,
            top: origin.y,
            right: origin.x + rect.right,
            bottom: origin.y + rect.bottom,
        }
    }

    pub fn unmaximize_in_place(hwnd: *mut c_void) -> Option<Restore> {
        if unsafe { IsZoomed(hwnd) } == 0 {
            return None;
        }
        let target = client_rect(hwnd);
        let mut current = placement(hwnd);
        let normal = current.rcNormalPosition;
        // Leave maximized at the maximized window rectangle (placement rectangles are relative to the work
        // area), so nothing visibly moves before the client-area correction below.
        let mut monitor: MONITORINFO = unsafe { std::mem::zeroed() };
        monitor.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        unsafe {
            GetMonitorInfoW(
                MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST),
                &mut monitor,
            )
        };
        let (dx, dy) = (
            monitor.rcWork.left - monitor.rcMonitor.left,
            monitor.rcWork.top - monitor.rcMonitor.top,
        );
        let outer = window_rect(hwnd);
        current.rcNormalPosition = RECT {
            left: outer.left - dx,
            top: outer.top - dy,
            right: outer.right - dx,
            bottom: outer.bottom - dy,
        };
        current.showCmd = SW_SHOWNORMAL as _;
        current.flags = 0;
        unsafe { SetWindowPlacement(hwnd, &current) };
        // A normal window keeps invisible resize borders that a maximized one hides off-screen, so place it
        // by its client area to keep the visible window exactly where it was.
        let (outer, inner) = (window_rect(hwnd), client_rect(hwnd));
        let (left, top) = (
            target.left - (inner.left - outer.left),
            target.top - (inner.top - outer.top),
        );
        let width =
            (target.right - target.left) + (outer.right - outer.left) - (inner.right - inner.left);
        let height =
            (target.bottom - target.top) + (outer.bottom - outer.top) - (inner.bottom - inner.top);
        unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                left,
                top,
                width,
                height,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
        Some(Restore {
            left: normal.left,
            top: normal.top,
            right: normal.right,
            bottom: normal.bottom,
        })
    }

    pub fn maximize_with_restore(hwnd: *mut c_void, restore: Restore) {
        // Maximize first, then swap in the restore rectangle; setting it while normal would show it for a frame.
        unsafe { ShowWindow(hwnd, SW_MAXIMIZE) };
        let mut current = placement(hwnd);
        current.rcNormalPosition = RECT {
            left: restore.left,
            top: restore.top,
            right: restore.right,
            bottom: restore.bottom,
        };
        current.showCmd = SW_SHOWMAXIMIZED as _;
        current.flags = 0;
        unsafe { SetWindowPlacement(hwnd, &current) };
    }
}
