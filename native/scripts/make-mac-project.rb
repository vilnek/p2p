# Makes macos/P2PTalk.xcodeproj: P2P Talk for Mac (native macOS app, AppKit + the Mac's web view).
# Same bundle ID as the iPhone/iPad app (com.vilnek.p2p), so the Mac app joins the same App Store record
# (universal purchase). The web app is ../www/index.html (npm run sync-web), bundled as Resources/index.html.
#
# Run again only if the project's files or settings change: ruby scripts/make-mac-project.rb
# Build: xcodebuild -project macos/P2PTalk.xcodeproj -scheme P2PTalk -configuration Release build
require 'xcodeproj'
require 'fileutils'

root = File.expand_path(File.join(__dir__, '..'))
dir = File.join(root, 'macos')
path = File.join(dir, 'P2PTalk.xcodeproj')
FileUtils.rm_rf(path)
project = Xcodeproj::Project.new(path)
project.root_object.attributes['LastUpgradeCheck'] = '2700'

target = project.new_target(:application, 'P2PTalk', :osx, '13.0')
group = project.main_group.new_group('P2PTalk', 'P2PTalk')
%w[AppDelegate.swift MainWindow.swift].each do |f|
  target.source_build_phase.add_file_reference(group.new_reference(f))
end
%w[Assets.xcassets PrivacyInfo.xcprivacy].each do |f|
  target.resources_build_phase.add_file_reference(group.new_reference(f))
end
%w[Info.plist P2PTalk.entitlements].each { |f| group.new_reference(f) }
web = project.main_group.new_group('Web app', '../www')
target.resources_build_phase.add_file_reference(web.new_reference('index.html'))

settings = {
  'PRODUCT_NAME' => 'P2P Talk',
  'PRODUCT_MODULE_NAME' => 'P2PTalk',
  'PRODUCT_BUNDLE_IDENTIFIER' => 'com.vilnek.p2p',
  'MARKETING_VERSION' => '26.10.1',
  'CURRENT_PROJECT_VERSION' => '261001.5',
  'INFOPLIST_FILE' => 'P2PTalk/Info.plist',
  'GENERATE_INFOPLIST_FILE' => 'NO',
  'CODE_SIGN_ENTITLEMENTS' => 'P2PTalk/P2PTalk.entitlements',
  'CODE_SIGN_STYLE' => 'Automatic',
  'CODE_SIGN_IDENTITY' => 'Apple Development',
  'DEVELOPMENT_TEAM' => '3A772ZZ2A9',
  'ENABLE_HARDENED_RUNTIME' => 'YES',
  'MACOSX_DEPLOYMENT_TARGET' => '13.0',
  'SDKROOT' => 'macosx',
  'SWIFT_VERSION' => '5.0',
  'ASSETCATALOG_COMPILER_APPICON_NAME' => 'AppIcon',
  'COMBINE_HIDPI_IMAGES' => 'YES',
  'DEAD_CODE_STRIPPING' => 'YES',
  'ENABLE_USER_SCRIPT_SANDBOXING' => 'YES',
  'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/../Frameworks']
}
target.build_configurations.each do |c|
  c.build_settings.merge!(settings)
  c.build_settings.delete('ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME')
  c.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = c.name == 'Debug' ? 'DEBUG' : ''
end
project.build_configurations.each do |c|
  c.build_settings['MACOSX_DEPLOYMENT_TARGET'] = '13.0'
  c.build_settings['ONLY_ACTIVE_ARCH'] = c.name == 'Debug' ? 'YES' : 'NO'
end
project.save

scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(target, nil, launch_target: true)
scheme.save_as(path, 'P2PTalk', true)
puts path
