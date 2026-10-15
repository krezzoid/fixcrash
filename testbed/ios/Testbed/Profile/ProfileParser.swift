import Foundation

struct ProfileParser {

    func parse(_ data: Data) throws -> Profile {
        let dto = try JSONDecoder().decode(ProfileDTO.self, from: data)
        return Profile(
            id: dto.id,
            displayName: dto.displayName,
            avatarURL: dto.avatar!.url
        )
    }
}
