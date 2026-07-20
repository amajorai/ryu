use serde::{Deserialize, Serialize};
use sysinfo::System;
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuInfo {
	pub name: String,
	pub arch: String,
	pub core_count: usize,
	pub extensions: Vec<String>,
	pub usage: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
	pub name: String,
	pub total_memory: u64,
	pub vendor: String,
	pub uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareData {
	pub cpu: CpuInfo,
	pub gpus: Vec<GpuInfo>,
	pub os_type: String,
	pub os_name: String,
	pub total_memory: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemUsage {
	pub cpu: f32,
	pub used_memory: u64,
	pub total_memory: u64,
}

fn get_cpu_extensions() -> Vec<String> {
	let mut extensions = Vec::new();

	#[cfg(target_arch = "x86_64")]
	{
		if is_x86_feature_detected!("sse") {
			extensions.push("sse".to_string());
		}
		if is_x86_feature_detected!("sse2") {
			extensions.push("sse2".to_string());
		}
		if is_x86_feature_detected!("sse3") {
			extensions.push("sse3".to_string());
		}
		if is_x86_feature_detected!("ssse3") {
			extensions.push("ssse3".to_string());
		}
		if is_x86_feature_detected!("sse4.1") {
			extensions.push("sse4_1".to_string());
		}
		if is_x86_feature_detected!("sse4.2") {
			extensions.push("sse4_2".to_string());
		}
		if is_x86_feature_detected!("avx") {
			extensions.push("avx".to_string());
		}
		if is_x86_feature_detected!("avx2") {
			extensions.push("avx2".to_string());
		}
		if is_x86_feature_detected!("fma") {
			extensions.push("fma".to_string());
		}
		if is_x86_feature_detected!("bmi1") {
			extensions.push("bmi1".to_string());
		}
		if is_x86_feature_detected!("bmi2") {
			extensions.push("bmi2".to_string());
		}
		if is_x86_feature_detected!("f16c") {
			extensions.push("f16c".to_string());
		}
	}

	#[cfg(target_arch = "aarch64")]
	extensions.push("neon".to_string());

	extensions
}

fn get_cpu_arch() -> String {
	std::env::consts::ARCH.to_string()
}

fn get_gpu_info() -> Vec<GpuInfo> {
	let mut gpus = Vec::new();

	#[cfg(target_os = "windows")]
	{
		use crate::win_process::NoWindow;

		if let Ok(out) = std::process::Command::new("nvidia-smi")
			.args([
				"--query-gpu=name,memory.total,uuid",
				"--format=csv,noheader",
			])
			.no_window()
			.output()
		{
			if out.status.success() {
				if let Ok(text) = String::from_utf8(out.stdout) {
					for line in text.lines() {
						let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
						if parts.len() >= 2 {
							let mem = parts[1].replace(" MiB", "").parse::<u64>().unwrap_or(0)
								* 1024 * 1024;
							gpus.push(GpuInfo {
								name: parts[0].to_string(),
								total_memory: mem,
								vendor: "NVIDIA".to_string(),
								uuid: parts.get(2).map(|s| s.to_string()),
							});
						}
					}
				}
			}
		}
	}

	gpus
}

#[command]
pub async fn get_hardware_info() -> Result<HardwareData, String> {
	let mut sys = System::new_all();
	sys.refresh_all();

	let cpu_name = sys
		.cpus()
		.first()
		.map(|c| c.brand().to_string())
		.unwrap_or_else(|| "Unknown CPU".to_string());
	let core_count = sys.cpus().len();
	let cpu_usage = sys.global_cpu_usage();

	Ok(HardwareData {
		cpu: CpuInfo {
			name: cpu_name,
			arch: get_cpu_arch(),
			core_count,
			extensions: get_cpu_extensions(),
			usage: cpu_usage,
		},
		gpus: get_gpu_info(),
		os_type: std::env::consts::OS.to_string(),
		os_name: System::long_os_version().unwrap_or_else(|| "Unknown".to_string()),
		total_memory: sys.total_memory(),
	})
}

#[command]
pub async fn get_system_usage() -> Result<SystemUsage, String> {
	let mut sys = System::new_all();
	sys.refresh_all();

	Ok(SystemUsage {
		cpu: sys.global_cpu_usage(),
		used_memory: sys.used_memory(),
		total_memory: sys.total_memory(),
	})
}
