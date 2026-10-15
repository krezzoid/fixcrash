import Foundation

struct Profile: Equatable {
    let id: String
    let displayName: String
    let avatarURL: URL
}

struct ProfileDTO: Decodable {
    let id: String
    let displayName: String
    let avatar: AvatarDTO?
}

struct AvatarDTO: Decodable {
    let url: URL
    let width: Int
    let height: Int
}
